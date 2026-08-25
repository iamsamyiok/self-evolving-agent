// core/experience-engine.js —— 经验自主进化（§5.3）：复盘 → 证据链强制 → 失败归因 → 检索/迭代
import { createHash } from 'node:crypto';
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { BM25Index, jaccard, tokenize } from '../utils/similarity.js';
import { wilsonLowerBound } from '../utils/stats.js';
import { chatJson, embed } from './llm-adapter.js';
import { backfillOne } from './embed-backfill.js';
import { EntityIndex } from './retrieval-cache.js';

export function traceHash(steps) {
  return createHash('sha256').update(JSON.stringify(steps ?? [])).digest('hex').slice(0, 16);
}

export class ExperienceEngine {
  constructor(store = new Store()) {
    this.store = store;
    this.idx = new EntityIndex(store, 'experience', (e) => `${e.task_signature} ${e.summary}`, {
      where: "WHERE state = 'ACTIVE'",
    });
  }

  active() { return [...this.idx.rows.values()]; }

  /**
   * 任务复盘：产出结构化经验。强制证据链（evidence）——无证据经验的复盘结论不允许入池（防幻影经验）。
   * 重复经验（签名相似）→ 合并进已有条目：sample_count+1、追加证据（进化侧合并，零破坏）。
   */
  async retrospect(trace) {
    if (!trace?.input) return null;
    // infra 类失败（限流/熔断/超时）与任务本身质量无关，复盘只会产出"环境坏了"式噪声经验污染检索池
    if (trace.outcome === 'FAIL' && /熔断|429|超时|ECONNREFUSED|ETIMEDOUT|rate limit/i.test(String(trace.error ?? ''))) {
      return null;
    }
    const prompt = [
      { role: 'system', content: '你是任务复盘器。输出 JSON：{"summary":"一句话结论","rules":["可复用规则"],"pitfalls":["避坑要点"],"failure_taxonomy":null}。failure_taxonomy 仅失败复盘时取值 plan|tool|llm|data|env。' },
      { role: 'user', content: `任务：${trace.input}\n结果：${trace.outcome}\n执行步骤：${JSON.stringify((trace.steps ?? []).map((s) => s.goal ?? s).slice(0, 8))}\n${trace.error ? '错误：' + String(trace.error).slice(0, 200) : ''}` },
    ];
    const out = await chatJson({
      messages: prompt,
      validate: (v) => (typeof v?.summary !== 'string' || v.summary.trim().length < 4 ? '须含非空 summary'
        : !Array.isArray(v?.rules) || !Array.isArray(v?.pitfalls) ? '须含 rules/pitfalls 数组' : null),
      label: 'experience-retrospect',
    });
    if (!out) return null; // 弃权：无证据不硬造（LLM 输出不可靠时宁可不入池）

    // 平凡成功不入池：成功 + 规则/避坑均为空 → 只有失败教训或有方法论的成功才值得沉淀
    // 结构化检查替代字符串启发式：避免"按步骤完成任务"等措辞误判，直接判定规则/避坑数组是否为空
    if (trace.outcome === 'SUCCESS' && !(out.rules?.length || out.pitfalls?.length)) {
      return null;
    }

    const evidence = [{ task_id: trace.id, outcome: trace.outcome, trace_hash: traceHash(trace.steps) }];
    const signature = [trace.input, out.summary].join(' ');
    const dup = this.findSimilar(trace.input, out.summary);
    if (dup) {
      await runExclusive(`experience:${dup.id}`, () => {
        const ev = this.store.get('experience', dup.id);
        const merged = [...JSON.parse(ev.evidence), ...evidence].slice(-20);
        this.store.update('experience', dup.id, {
          sample_count: ev.sample_count + 1,
          success_count: ev.success_count + (trace.outcome === 'SUCCESS' ? 1 : 0),
          fail_count: ev.fail_count + (trace.outcome === 'FAIL' ? 1 : 0),
          execution_count: ev.execution_count + 1,
          evidence: JSON.stringify(merged),
          last_used_at: Date.now(),
        });
      });
      return { status: 'merged', id: dup.id };
    }

    const id = uuid7();
    const now = Date.now();
    await runExclusive(`experience:${id}`, () => {
      this.store.insert('experience', {
        id, state: 'ACTIVE', version: 1, parent_id: null, origin: 'evolve',
        created_at: now, updated_at: now, immunity_until: now + CONFIG.IMMUNITY_HOURS * 3600_000,
        execution_count: 1, quality_score: 0.5, embedding: null,
        quarantined_at: null, purge_after: null, last_used_at: now,
        task_signature: signature.slice(0, 500),
        summary: out.summary.slice(0, 300),
        rules: JSON.stringify((out.rules ?? []).slice(0, 5)),
        pitfalls: JSON.stringify((out.pitfalls ?? []).slice(0, 5)),
        failure_taxonomy: trace.outcome === 'FAIL' ? (out.failure_taxonomy ?? 'llm') : null,
        evidence: JSON.stringify(evidence),
        sample_count: 1,
        success_count: trace.outcome === 'SUCCESS' ? 1 : 0,
        fail_count: trace.outcome === 'FAIL' ? 1 : 0,
      });
    });
    backfillOne(this.store, 'experience', id); // 异步补语义向量
    return { status: 'created', id };
  }

  /** 相似合并检测：input / summary 分别与存量 task_signature 比对，任一维度高相似即视为同一经验族——
   *  历史教训：input+summary 拼接成串再整串比 Jaccard 会被稀释，同输入不同措辞的经验重复入库 8 条 */
  findSimilar(input, summary) {
    const query = `${String(input ?? '')} ${String(summary ?? '')}`;
    const tokIn = tokenize(String(input ?? ''));
    const tokSum = tokenize(String(summary ?? ''));
    for (const h of this.idx.index.search(query, 3)) {
      const row = this.idx.rows.get(h.id);
      if (!row) continue;
      const tokSig = tokenize(String(row.task_signature ?? ''));
      const simIn = tokIn.length ? jaccard(tokIn, tokSig) : 0;
      const simSum = tokSum.length ? jaccard(tokSum, tokSig) : 0;
      if (Math.max(simIn, simSum) >= CONFIG.MEMORY_DUP_JACCARD) return row;
    }
    return null;
  }

  /** 检索：w·相似度 + w·Q（§5.3，权重可调参）；命中记账走 touch 旁路；score ≤0.3 不注入（防弱相关经验挤占上下文） */
  async retrieve(query, topK = CONFIG.RETRIEVAL_TOP_K, weights = { sim: 0.6, quality: 0.4 }) {
    const qv = await embed(query).catch(() => null);
    const hits = this.idx.hybridSearch(query, topK, qv); // 混合分归一化 [0,1]
    const out = [];
    for (const h of hits) {
      const row = this.idx.rows.get(h.id);
      if (!row) continue;
      const score = weights.sim * h.score + (weights.quality ?? 0.4) * row.quality_score;
      if (score <= 0.3) continue;
      out.push({ row, score });
    }
    if (out.length) this.store.touch('experience', out.map((o) => o.row.id), {});
    return out;
  }

  /** 经验命中的任务结果反馈（供 W 评分）；统计记账走 bumpStats 直写 */
  recordOutcome(id, ok) {
    const e = this.store.get('experience', id);
    if (!e) return;
    this.store.bumpStats('experience', id, {
      success_count: e.success_count + (ok ? 1 : 0),
      fail_count: e.fail_count + (ok ? 0 : 1),
      execution_count: e.execution_count + 1,
    });
  }

  wilson(id) {
    const e = this.store.get('experience', id);
    if (!e) return 0;
    return wilsonLowerBound(e.success_count, e.execution_count || e.sample_count);
  }
}
