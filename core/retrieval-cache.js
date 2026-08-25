// core/retrieval-cache.js —— 实体检索索引缓存
// 解决：记忆/技能/经验积累后，每次任务检索都要 SELECT 全量行 + 重建 BM25 索引（O(N) 分词），
// 响应时间随数据量线性劣化。
//
// 三层手段：
// 1. 快照校验：COUNT + SUM(version) + MAX(updated_at) 一条聚合 SQL 判断数据是否变化，未变直接命中缓存
// 2. 增量同步：变化时按 id diff，只对新增/变更/删除的条目重分词（配合 store.touch/bumpStats 记账旁路，
//    检索命中的 access_count 记账不会触发任何重建）
// 3. 冷热裁剪：超过 maxRows 时按温度（质量 + 重要性 + 时近性）保留最热子集，检索量有上界（渐进式加载）
import { BM25Index, vecFromB64, topKByCosine } from '../utils/similarity.js';
import { TABLES } from './store-base.js';

export class EntityIndex {
  /**
   * @param store Store 实例
   * @param entityType 'skill' | 'memory' | 'experience'
   * @param textOf row => 检索文本
   * @param where SQL 过滤片段（含 WHERE），如 "WHERE state = 'ACTIVE'"
   * @param maxRows 缓存条目上界（0 = 不裁剪）；超出按温度保留最热子集
   */
  constructor(store, entityType, textOf, { where = '', maxRows = 0 } = {}) {
    this.store = store;
    this.entityType = entityType;
    this.textOf = textOf;
    this.where = where;
    this.maxRows = maxRows;
    this._key = null;
    this._rows = new Map();
    this._idx = new BM25Index();
    this._builtAt = 0;
    this.rebuilds = 0;
  }

  /** 聚合快照：INSERT/DELETE 变 COUNT，真实 UPDATE 递增 version 且刷新 updated_at；记账旁路两者都不动 */
  _snapshot() {
    const table = TABLES[this.entityType];
    const r = this.store.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(version), 0) AS v, COALESCE(MAX(updated_at), 0) AS m FROM ${table} ${this.where}`)
      .get();
    return `${r.n}:${r.v}:${r.m}`;
  }

  /** 温度 = 质量·0.5 + 重要性·0.2 + 时近性·0.3（τ=30 天），冷条目在裁剪时让位 */
  _temperature(row, now) {
    const rec = Math.exp(-((now - (row.last_used_at ?? row.created_at ?? now)) / 86_400_000) / 30);
    return (row.quality_score ?? 0.5) * 0.5 + (row.importance ?? 0.5) * 0.2 + (Number.isFinite(rec) ? rec : 0) * 0.3;
  }

  _loadRows() {
    let rows = this.store.list(this.entityType, this.where);
    if (this.maxRows > 0 && rows.length > this.maxRows) {
      const now = Date.now();
      rows = rows
        .map((r) => ({ r, t: this._temperature(r, now) }))
        .sort((a, b) => b.t - a.t || String(a.r.id).localeCompare(String(b.r.id)))
        .slice(0, this.maxRows)
        .map((x) => x.r);
    }
    return rows;
  }

  /** 快照变化才同步；增量 diff 只重分词变更条目。返回 this 便于链式调用 */
  refresh() {
    const key = this._snapshot();
    if (key === this._key) return this;
    const rows = this._loadRows();
    const next = new Map(rows.map((r) => [r.id, r]));
    for (const id of this._rows.keys()) if (!next.has(id)) { this._idx.remove(id); this._vecs?.delete(id); }
    this._vecs ??= new Map(); // id -> 单位向量（bge-m3 base64 解码；无向量行不入表）
    for (const [id, row] of next) {
      const old = this._rows.get(id);
      if (!old || old.version !== row.version || old.updated_at !== row.updated_at) {
        if (old) this._idx.remove(id);
        this._idx.add(id, this.textOf(row));
        const v = vecFromB64(row.embedding);
        if (v) this._vecs.set(id, v); else this._vecs.delete(id);
      }
    }
    this._rows = next;
    this._key = key;
    this._builtAt = Date.now();
    this.rebuilds++;
    return this;
  }

  get rows() { this.refresh(); return this._rows; }

  get index() { this.refresh(); return this._idx; }

  get vecs() { this.refresh(); return this._vecs; }

  search(query, topK) { this.refresh(); return this._idx.search(query, topK); }

  /** 混合检索：BM25（词面精确）+ 向量余弦（语义泛化）双路召回 → 归一化融合。
   *  queryVec 为 null（未配置/失败）时退化为纯 BM25，行为与旧版一致。
   *  融合：text = 0.45*bm25_norm + 0.55*cos（任一路召回即可候选，另一路缺失记 0） */
  hybridSearch(query, topK, queryVec) {
    this.refresh();
    const bm = this._idx.search(query, topK * 2);
    const maxBm = bm.length ? bm[0].score : 0;
    const cosHits = queryVec && this._vecs.size ? topKByCosine(queryVec, [...this._vecs.entries()].map(([id, vec]) => ({ id, vec })), topK * 2) : [];
    const merged = new Map();
    for (const h of bm) merged.set(h.id, { id: h.id, bm25: maxBm > 0 ? h.score / maxBm : 0, cos: 0 });
    for (const h of cosHits) {
      const prev = merged.get(h.id) ?? { id: h.id, bm25: 0, cos: 0 };
      prev.cos = Math.max(0, h.score);
      merged.set(h.id, prev);
    }
    const hasVec = cosHits.length > 0;
    const out = [...merged.values()]
      .filter((m) => hasVec && queryVec ? (m.bm25 > 0.3 && m.cos > 0) : m.bm25 > 0.3) // 双阈值防跨查询评分不可比：bm25 单独必须 > 0.3，混合时 cos 也必须 > 0
      .map((m) => ({
        id: m.id,
        score: hasVec && queryVec ? 0.45 * m.bm25 + 0.55 * m.cos : m.bm25,
        bm25: m.bm25,
        cos: m.cos,
      }));
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }

  /** 缓存状态（测试/诊断用）：条目数、重建次数、最近构建时间 */
  stats() {
    this.refresh();
    return { rows: this._rows.size, vecs: this._vecs?.size ?? 0, rebuilds: this.rebuilds, builtAt: this._builtAt };
  }
}
