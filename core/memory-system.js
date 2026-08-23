// core/memory-system.js —— 记忆动态进化（§5.2）：异步提取 → 去重 → 冲突消解 → 分层写入 → 检索
import { createHash } from 'node:crypto';
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { BM25Index, candidatePairs, jaccard, tokenize } from '../utils/similarity.js';
import { memoryImportance } from '../utils/stats.js';
import { chat, chatJson } from './llm-adapter.js';

export class MemorySystem {
  constructor(store = new Store()) {
    this.store = store;
  }

  activeMemories() {
    return this.store.list('memory', "WHERE state = 'ACTIVE'");
  }

  /** 被 ACTIVE 后继 supersede 的记忆视为已取代（保留不删，链式关联，§5.2） */
  supersededIds() {
    const s = new Set();
    for (const m of this.activeMemories()) if (m.supersede_of) s.add(m.supersede_of);
    return s;
  }

  /**
   * 写入记忆（带免疫期、时间元数据、写前去重与冲突消解）。
   * 返回 { status: 'created' | 'dup_skipped' | 'superseded', id? }
   */
  async create({ content, kind = 'semantic', tier = 'short', importance = 0.5, taskId = null, skipLLM = false }) {
    const now = Date.now();
    const imm = now + CONFIG.IMMUNITY_HOURS * 3600_000;

    // 写前去重：与同 tier ACTIVE 记忆高度相似 → 不写入（进化侧零破坏去重）
    const dup = this.findDuplicate(content, tier);
    if (dup) {
      this.store.logPurge({ epoch: this.store.epoch, entityType: 'memory', entityId: dup.id, action: 'DEDUP_SKIP', dimension: 'memory', reason: `写入内容与现有记忆相似度过高（tier=${tier}）`, evidence: { dup_of: dup.id, sim: dup.sim }, status: 'DONE' });
      return { status: 'dup_skipped', id: dup.id };
    }

    // 冲突消解：与新记忆语义相反的旧记忆 → 保留不删，链式关联（judge 双采样一致才判定）
    let supersedeOf = null;
    if (!skipLLM && content) {
      const nearest = this.nearest(content, tier);
      if (nearest && nearest.sim >= 0.3) {
        const r = await judgeConflict(nearest.row.content, content);
        if (r.verdict === 'CONFLICT') supersedeOf = nearest.row.id;
      }
    }

    const id = uuid7();
    const expiresAt = tier === 'short' ? now + 7 * 86_400_000 : null;
    await runExclusive(`memory:${id}`, () => {
      this.store.insert('memory', {
        id, state: 'ACTIVE', version: 1, parent_id: null, origin: 'evolve',
        created_at: now, updated_at: now, immunity_until: imm,
        execution_count: 0, quality_score: 0.5, embedding: null,
        quarantined_at: null, purge_after: null, last_used_at: now,
        tier, kind, content, importance, access_count: 0,
        expires_at: expiresAt, supersede_of: supersedeOf, entities: null, task_id: taskId,
      });
    });
    return { status: supersedeOf ? 'superseded' : 'created', id };
  }

  /** 去重检测：同 tier 下 BM25 召回 + Jaccard 精算 ≥ MEMORY_DUP_JACCARD */
  findDuplicate(content, tier) {
    const actives = this.activeMemories().filter((m) => m.tier === tier);
    if (!actives.length) return null;
    const idx = new BM25Index(actives.map((m) => ({ id: m.id, text: m.content })));
    const hits = idx.search(content, 5);
    const tokA = tokenize(content);
    for (const h of hits) {
      const row = actives.find((m) => m.id === h.id);
      const sim = jaccard(tokA, tokenize(row.content));
      if (sim >= CONFIG.MEMORY_DUP_JACCARD) return { id: row.id, sim: Math.max(sim, h.score) };
    }
    return null;
  }

  nearest(content, tier) {
    const actives = this.activeMemories().filter((m) => m.tier === tier);
    if (!actives.length) return null;
    const idx = new BM25Index(actives.map((m) => ({ id: m.id, text: m.content })));
    const top = idx.search(content, 1)[0];
    if (!top) return null;
    return { row: actives.find((m) => m.id === top.id), sim: top.score };
  }

  /** 检索：score = w·相似度 + w·Q + w·时近性（权重可调参）；注入即 access_count+1（§5.2） */
  retrieve(query, topK = CONFIG.RETRIEVAL_TOP_K, weights = { sim: 0.6, quality: 0.25, recency: 0.15 }) {
    const superseded = this.supersededIds();
    const actives = this.activeMemories().filter((m) => !superseded.has(m.id) && m.tier !== 'instant');
    if (!actives.length) return [];
    const idx = new BM25Index(actives.map((m) => ({ id: m.id, text: m.content })));
    const hits = idx.search(query, topK * 2);
    const now = Date.now();
    const scored = hits.map((h) => {
      const row = actives.find((m) => m.id === h.id);
      const rec = Math.exp(-((now - (row.last_used_at ?? row.created_at)) / 86_400_000) / 14);
      const recency = Number.isFinite(rec) ? rec : 0;
      return { row, score: weights.sim * h.score + weights.quality * row.quality_score + weights.recency * recency };
    }).filter((x) => x.score > 0.15); // 低分不注入，防上下文污染
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored.slice(0, topK)) {
      this.store.update('memory', s.row.id, { access_count: s.row.access_count + 1, last_used_at: now });
    }
    return scored.slice(0, topK);
  }

  /** 任务轨迹 → 候选记忆抽取（异步管线，不阻塞下一任务）。LLM 不可用/弃权时降级为直接沉淀任务要点。 */
  async extractFromTrace(trace) {
    if (!trace?.input) return [];
    const prompt = [
      { role: 'system', content: '你是记忆抽取器。从任务轨迹中提取值得长期记住的事实/流程要点，输出 JSON：{"memories":[{"content":"...","kind":"semantic|episodic|procedural","importance":0.0-1.0}]}。没有值得记的就输出空数组。' },
      { role: 'user', content: `任务：${trace.input}\n结果：${trace.outcome}\n回答摘要：${(trace.answer ?? '').slice(0, 400)}` },
    ];
    const out = await chatJson({
      messages: prompt,
      validate: (v) => (!Array.isArray(v?.memories) ? '须含 memories 数组' : v.memories.some((m) => typeof m?.content !== 'string' || m.content.trim().length < 4) ? 'content 须为非空字符串' : null),
      label: 'memory-extract',
    });
    const candidates = out?.memories ?? [];
    const results = [];
    for (const c of candidates.slice(0, 3)) {
      results.push(await this.create({
        content: c.content.trim().slice(0, 300),
        kind: ['semantic', 'episodic', 'procedural'].includes(c.kind) ? c.kind : 'semantic',
        tier: 'short',
        importance: Math.min(1, Math.max(0, Number(c.importance) || 0.5)),
        taskId: trace.id,
      }));
    }
    return results;
  }
}

/** 冲突判定（judge 双采样一致才判 CONFLICT，否则视为无冲突——弃权即保守不动作） */
async function judgeConflict(oldContent, newContent) {
  const { judge } = await import('./llm-adapter.js');
  return judge({
    system: '你是记忆冲突检测器。判断两条记忆是否语义相反/互相矛盾。',
    question: `记忆A：「${oldContent.slice(0, 120)}」\n记忆B：「${newContent.slice(0, 120)}」\n两条记忆是否冲突？`,
    options: ['CONFLICT', 'OK'],
  });
}
