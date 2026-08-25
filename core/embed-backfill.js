// core/embed-backfill.js —— embedding 写时补充与存量回填
// 写时：新实体 insert 后 fire-and-forget 补向量（失败静默，BM25 兜底）
// 存量：启动 45s 后批量回填（batch 16 / 间隔 1s，免费档限速友好；进程退出即停）
import { embedBatch } from './llm-adapter.js';
import { vecToB64 } from '../utils/similarity.js';
import { TABLES } from './store-base.js';

/** 单条实体的检索文本（与该实体 EntityIndex 的 textOf 保持一致） */
function textOf(entityType, row) {
  if (entityType === 'skill') return `${row.name} ${row.scenario} ${row.description}`;
  if (entityType === 'memory') return row.content ?? '';
  if (entityType === 'experience') return `${row.summary ?? ''} ${row.rules ?? ''}`;
  return '';
}

/** 写时补向量（fire-and-forget；直写 embedding+updated_at 触发索引增量同步向量 Map） */
export function backfillOne(store, entityType, id) {
  if (!store?.db) return;
  queueMicrotask(async () => {
    try {
      const table = TABLES[entityType];
      const row = store.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (!row || row.embedding) return;
      const [vec] = await embedBatch([textOf(entityType, row)]);
      if (!vec) return;
      store.db.prepare(`UPDATE ${table} SET embedding = ?, updated_at = ? WHERE id = ? AND embedding IS NULL`)
        .run(vecToB64(vec), Date.now(), id);
    } catch { /* 静默：向量缺失时检索自动退化 BM25 */ }
  });
}

/** 存量批量回填（启动后台任务；返回 Promise 供测试，生产 fire-and-forget） */
export async function backfillAll(store, { batchSize = 16, intervalMs = 1000, log = () => {} } = {}) {
  const total = { done: 0, fail: 0 };
  for (const entityType of ['skill', 'memory', 'experience']) {
    const table = TABLES[entityType];
    let cursor = '';
    for (;;) {
      let rows;
      try {
        rows = store.db.prepare(
          `SELECT id, name, scenario, description, content, summary, rules FROM ${table}
           WHERE embedding IS NULL AND id > ? AND state IN ('ACTIVE','COOLING','DRAFT','WARM')
           ORDER BY id LIMIT ?`
        ).all(cursor, batchSize);
      } catch (e) {
        log(`${entityType} 回填查询失败：${String(e?.message ?? e).slice(0, 80)}`);
        break;
      }
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      const vecs = await embedBatch(rows.map((r) => textOf(entityType, r))).catch(() => rows.map(() => null));
      let wrote = 0;
      for (let i = 0; i < rows.length; i++) {
        if (!vecs[i]) { total.fail++; continue; }
        try {
          const r = store.db.prepare(`UPDATE ${table} SET embedding = ?, updated_at = ? WHERE id = ? AND embedding IS NULL`)
            .run(vecToB64(vecs[i]), Date.now(), rows[i].id);
          if (r.changes) wrote++;
        } catch { total.fail++; }
      }
      total.done += wrote;
      log(`${entityType} +${wrote} 向量（累计 ${total.done}）`);
      await new Promise((ok) => setTimeout(ok, intervalMs)); // 限速：免费档 RPM 友好
    }
  }
  return total;
}
