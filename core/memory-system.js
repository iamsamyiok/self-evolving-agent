// core/memory-system.js —— 记忆动态进化（§5.2）：异步提取 → 去重 → 冲突消解 → 分层写入 → 检索
import { createHash } from 'node:crypto';
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { BM25Index, candidatePairs, jaccard, tokenize } from '../utils/similarity.js';
import { memoryImportance } from '../utils/stats.js';
import { chat, chatJson, embed } from './llm-adapter.js';
import { backfillOne } from './embed-backfill.js';
import { EntityIndex } from './retrieval-cache.js';

export class MemorySystem {
  constructor(store = new Store()) {
    this.store = store;
    // 检索索引缓存：快照校验 + 增量同步 + 冷热裁剪（记忆规模增长不拖慢检索）
    this.idx = new EntityIndex(store, 'memory', (m) => m.content, {
      where: "WHERE state = 'ACTIVE'",
      maxRows: CONFIG.MEMORY_INDEX_MAX_ROWS ?? 20000,
    });
  }

  activeMemories() {
    return [...this.idx.rows.values()];
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
  async create({ content, kind = 'semantic', tier = 'short', importance = 0.5, taskId = null, skipLLM = false, conversationId = null }) {
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
        execution_count: 0, quality_score: Math.max(0.3, importance), // 初始质量 = 重要性（复用/沉淀动态修正）
        embedding: null,
        quarantined_at: null, purge_after: null, last_used_at: now,
        tier, kind, content, importance, access_count: 0,
        expires_at: expiresAt, supersede_of: supersedeOf, entities: conversationId ? JSON.stringify({ conversation_id: conversationId }) : null, task_id: taskId,
      });
    });
    backfillOne(this.store, 'memory', id); // 异步补语义向量（失败静默，BM25 兜底）
    return { status: supersedeOf ? 'superseded' : 'created', id };
  }

  /** 去重检测：BM25 召回（全量缓存索引）+ 同 tier 校验 + Jaccard 精算 ≥ MEMORY_DUP_JACCARD */
  findDuplicate(content, tier) {
    const hits = this.idx.index.search(content, 16);
    if (!hits.length) return null;
    const tokA = tokenize(content);
    for (const h of hits) {
      const row = this.idx.rows.get(h.id);
      if (!row || row.tier !== tier) continue;
      const sim = jaccard(tokA, tokenize(row.content));
      if (sim >= CONFIG.MEMORY_DUP_JACCARD) return { id: row.id, sim: Math.max(sim, h.score) };
    }
    return null;
  }

  nearest(content, tier) {
    for (const h of this.idx.index.search(content, 8)) {
      const row = this.idx.rows.get(h.id);
      if (row && row.tier === tier) return { row, sim: h.score };
    }
    return null;
  }

  /** 检索：instant 优先（会话上下文）→ 语义/程序记忆（混合分过滤）；注入记账走 touch 旁路 */
  async retrieve(query, topK = CONFIG.RETRIEVAL_TOP_K, weights = { sim: 0.6, quality: 0.25, recency: 0.15 }) {
    const superseded = this.supersededIds();
    const qv = await embed(query).catch(() => null);
    const hits = this.idx.hybridSearch(query, topK * 2, qv);
    const now = Date.now();

    // instant 记忆独立 bucket：用户本轮纠正/偏好直接注入，优先级高于语义召回
    const instantHits = [];
    for (const h of hits) {
      const row = this.idx.rows.get(h.id);
      if (row && row.tier === 'instant' && !superseded.has(row.id)) {
        instantHits.push({ row, score: h.score, instant: true });
      }
    }
    const instantPicked = instantHits
      .filter((x) => x.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.ceil(topK * 0.3)); // instant 最多占 topK 的 30%
    if (instantPicked.length) this.store.touch('memory', instantPicked.map((s) => s.row.id), { access: true });

    // 其余 tier 记忆：双阈值过滤
    const scored = [];
    for (const h of hits) {
      const row = this.idx.rows.get(h.id);
      if (!row || superseded.has(row.id) || row.tier === 'instant') continue;
      const rec = Math.exp(-((now - (row.last_used_at ?? row.created_at)) / 86_400_000) / 14);
      const recency = Number.isFinite(rec) ? rec : 0;
      const rawScore = weights.sim * h.score + weights.quality * row.quality_score + weights.recency * recency;
      if (h.score > 0.15 && h.bm25 > 0.3) { // 双阈值：防单路召回低质条目
        scored.push({ row, score: rawScore });
      }
    }
    const nonInstant = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK - instantPicked.length);
    if (nonInstant.length) this.store.touch('memory', nonInstant.map((s) => s.row.id), { access: true });
    return [...instantPicked, ...nonInstant];
  }

  /** 任务轨迹 → 候选记忆抽取（异步管线，不阻塞下一任务）。LLM 不可用/弃权时降级为直接沉淀任务要点。 */
  async extractFromTrace(trace) {
    if (!trace?.input) return [];
    // infra 类失败（限流/熔断/超时）无记忆价值，跳过抽取避免噪声入库
    if (trace.outcome === 'FAIL' && /熔断|429|超时|ECONNREFUSED|ETIMEDOUT|rate limit/i.test(String(trace.error ?? ''))) {
      return [];
    }
    const prompt = [
      { role: 'system', content: '你是记忆抽取器。只提取「未来同类任务能直接复用的具体事实或方法」。输出 JSON：{"memories":[{"content":"...","kind":"semantic|episodic|procedural","importance":0.0-1.0}]}，没有就输出空数组。\n\n好记忆（具体、可复用）：\n- "GitHub 仓库页用 http_get 拿到的是 HTML，需提取 title/正文再用"\n- "复利公式 (1+r)^n*P，用 calc 工具精确计算"\n\n坏记忆（任务复述，禁止输出）：\n- "任务成功完成了" / "用户问了天气问题" / "步骤执行顺利"\n- 与任务无泛化价值的过程描述' },
      { role: 'user', content: `任务：${trace.input}\n结果：${trace.outcome}\n步骤要点：${JSON.stringify((trace.steps ?? []).map((s) => s.goal)).slice(0, 300)}\n回答摘要：${(trace.answer ?? '').slice(0, 400)}` },
    ];
    const out = await chatJson({
      messages: prompt,
      validate: (v) => (!Array.isArray(v?.memories) ? '须含 memories 数组' : v.memories.some((m) => typeof m?.content !== 'string' || m.content.trim().length < 4) ? 'content 须为非空字符串' : null),
      label: 'memory-extract',
    });
    const candidates = out?.memories ?? [];
    const results = [];
    for (const c of candidates.slice(0, 3)) {
      const importance = Math.min(1, Math.max(0, Number(c.importance) || 0.5));
      // 质量门槛：低重要性记忆不入库（复述型任务 LLM 常给 0.4-0.5，真实复用价值需 ≥0.55）
      if (importance < (CONFIG.MEMORY_MIN_IMPORTANCE ?? 0.55)) continue;
      results.push(await this.create({
        content: c.content.trim().slice(0, 300),
        kind: ['semantic', 'episodic', 'procedural'].includes(c.kind) ? c.kind : 'semantic',
        tier: 'short',
        importance,
        taskId: trace.id,
        conversationId: trace.conversationId ?? null, // 会话标签：同会话后续任务检索时权重加倍
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
