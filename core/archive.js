// core/archive.js —— 任务档案层（B2，吸收 dual-agent memory-archive 设计）
// 档案库 = tasks 表本身（input + answer 落库即归档，零额外写路径）；
// 增量在"检索"：新任务规划前 BM25 检索历史任务，命中即注入上下文——
// 用户反复问同类问题/上次交付可直接复用时，规划器不再从零摸索。
// 纪律：只注入 SUCCESS 且答案非空的记录（失败交付复用是负资产）；
//       条目标注"仅供参考"，防旧任务带偏新目标（dual-agent 同款护栏文案）。
import { BM25Index } from '../utils/similarity.js';

const ARCHIVE_WINDOW = 300; // 只索引最近 N 条（BM25 全量重建，窗口防大库变慢）
const ARCHIVE_TOPK = 3;

/** BM25 检索历史成功任务。返回 [{ id, input, answer, when }]（相关度降序） */
export function searchArchive(store, query, { topK = ARCHIVE_TOPK, window = ARCHIVE_WINDOW } = {}) {
  if (!store?.db || !String(query ?? '').trim()) return [];
  let rows;
  try {
    rows = store.db.prepare(
      "SELECT id, input, answer, created_at FROM tasks WHERE status = 'done' AND outcome = 'SUCCESS' AND answer IS NOT NULL AND length(answer) > 10 ORDER BY created_at DESC LIMIT ?"
    ).all(window);
  } catch { return []; }
  if (rows.length < 2) return []; // 少于 2 条无检索价值（省索引构建）
  const idx = new BM25Index(rows.map((r) => ({ id: r.id, text: `${r.input}\n${String(r.answer).slice(0, 2000)}` })));
  return idx.search(String(query), topK)
    .map((h) => rows.find((r) => r.id === h.id))
    .filter(Boolean)
    .map((r) => ({
      id: r.id,
      input: String(r.input).replace(/\s+/g, ' ').slice(0, 80),
      answer: String(r.answer).replace(/\s+/g, ' ').slice(0, 160),
      when: new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' '),
      score: 0,
    }));
}

/** 档案条目 → 上下文注入文本（带防带偏护栏） */
export function formatArchive(hits) {
  if (!hits?.length) return '';
  const lines = hits.map((h) => `- [${h.when}] 问：${h.input}${h.input.length >= 80 ? '…' : ''}\n  答：${h.answer}${h.answer.length >= 160 ? '…' : ''}`);
  return `【过往任务档案】\n以下是自动检索到的相关历史任务（仅供参考，与本任务无关时必须忽略，禁止被旧任务带偏目标）：\n${lines.join('\n')}`;
}
