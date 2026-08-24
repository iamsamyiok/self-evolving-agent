// core/experience-engine.js —— 经验自主进化（§5.3）：复盘 → 证据链强制 → 失败归因 → 检索/迭代
import { createHash } from 'node:crypto';
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { BM25Index, jaccard, tokenize } from '../utils/similarity.js';
import { wilsonLowerBound } from '../utils/stats.js';
import { chatJson } from './llm-adapter.js';

export function traceHash(steps) {
  return createHash('sha256').update(JSON.stringify(steps ?? [])).digest('hex').slice(0, 16);
}

export class ExperienceEngine {
  constructor(store = new Store()) { this.store = store; }

  active() { return this.store.list('experience', "WHERE state = 'ACTIVE'"); }

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

    const evidence = [{ task_id: trace.id, outcome: trace.outcome, trace_hash: traceHash(trace.steps) }];
    const signature = [trace.input, out.summary].join(' ');
    const dup = this.findSimilar(signature);
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
    return { status: 'created', id };
  }

  findSimilar(signature) {
    const actives = this.active();
    if (!actives.length) return null;
    const idx = new BM25Index(actives.map((e) => ({ id: e.id, text: e.task_signature })));
    const tokA = tokenize(signature);
    for (const h of idx.search(signature, 3)) {
      const row = actives.find((e) => e.id === h.id);
      if (jaccard(tokA, tokenize(row.task_signature)) >= CONFIG.MEMORY_DUP_JACCARD) return row;
    }
    return null;
  }

  /** 检索：w·相似度 + w·Q（§5.3，权重可调参） */
  retrieve(query, topK = CONFIG.RETRIEVAL_TOP_K, weights = { sim: 0.6, quality: 0.4 }) {
    const actives = this.active();
    if (!actives.length) return [];
    const idx = new BM25Index(actives.map((e) => ({ id: e.id, text: `${e.task_signature} ${e.summary}` })));
    const hits = idx.search(query, topK);
    const now = Date.now();
    const out = hits.map((h) => {
      const row = actives.find((e) => e.id === h.id);
      return { row, score: weights.sim * h.score + (weights.quality ?? 0.4) * row.quality_score };
    });
    for (const o of out) this.store.update('experience', o.row.id, { last_used_at: now });
    return out;
  }

  /** 经验命中的任务结果反馈（供 W 评分） */
  recordOutcome(id, ok) {
    const e = this.store.get('experience', id);
    if (!e) return;
    this.store.update('experience', id, {
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
