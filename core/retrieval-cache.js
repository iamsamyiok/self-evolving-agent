// core/retrieval-cache.js —— 实体检索索引缓存
// 解决：记忆/技能/经验积累后，每次任务检索都要 SELECT 全量行 + 重建 BM25 索引（O(N) 分词），
// 响应时间随数据量线性劣化。
//
// 三层手段：
// 1. 快照校验：COUNT + SUM(version) + MAX(updated_at) 一条聚合 SQL 判断数据是否变化，未变直接命中缓存
// 2. 增量同步：变化时按 id diff，只对新增/变更/删除的条目重分词（配合 store.touch/bumpStats 记账旁路，
//    检索命中的 access_count 记账不会触发任何重建）
// 3. 冷热裁剪：超过 maxRows 时按温度（质量 + 重要性 + 时近性）保留最热子集，检索量有上界（渐进式加载）
import { BM25Index } from '../utils/similarity.js';
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
    for (const id of this._rows.keys()) if (!next.has(id)) this._idx.remove(id);
    for (const [id, row] of next) {
      const old = this._rows.get(id);
      if (!old || old.version !== row.version || old.updated_at !== row.updated_at) {
        if (old) this._idx.remove(id);
        this._idx.add(id, this.textOf(row));
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

  search(query, topK) { this.refresh(); return this._idx.search(query, topK); }

  /** 缓存状态（测试/诊断用）：条目数、重建次数、最近构建时间 */
  stats() {
    this.refresh();
    return { rows: this._rows.size, rebuilds: this.rebuilds, builtAt: this._builtAt };
  }
}
