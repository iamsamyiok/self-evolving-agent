// utils/similarity.js —— BM25 检索（三级降级第 2 档）+ 倒排索引候选预筛 + Jaccard 精算
// 纪律（附录 B-4）：禁止全库两两比对；先倒排索引召回共享 token 的候选，再对候选精算。

/** 分词：CJK 按二元 bigram，拉丁按词；小写化、去停用词 */
export function tokenize(text) {
  if (!text) return [];
  const out = [];
  const latin = text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
  out.push(...latin.filter((w) => !STOPWORDS.has(w)));
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const seg of cjk) {
    if (seg.length === 1) out.push(seg);
    else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
  }
  return out;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'of', 'to', 'and', 'in', 'on', 'for', 'with', 'that', 'this', 'it', 'as', 'be', 'by', 'or', 'at', 'if']);

/** 任务域同义词组（查询侧扩展用）：BM25 纯词法对跨说法召回弱（"省钱"检索不到"成本优化"），
 *  命中任一词 → 组内其余词的 token 并入查询。文档侧不扩（防索引膨胀）。 */
const SYNONYM_GROUPS = [
  ['省钱', '节约', '节省', '降本', '成本优化', 'cost'],
  ['新闻', '资讯', '热点', '时事', 'news'],
  ['模型', '大模型', 'llm', 'ai'],
  ['汇率', '货币', '外汇', 'exchange', 'rate'],
  ['天气', '气温', '预报', 'weather'],
  ['文档', 'docs', 'documentation', '说明'],
  ['报错', '错误', 'error', '异常', 'bug', '失败'],
  ['部署', 'deploy', '上线', '发布', 'release'],
  ['配置', 'config', '设置', 'settings', '参数'],
  ['搜索', 'search', '检索', '查询', '查找'],
  ['总结', '摘要', 'summary', '概括', '归纳'],
  ['对比', '比较', 'compare', 'versus', 'vs', '区别'],
  ['优化', 'optimize', '改进', 'improve', '提升', '调优'],
  ['价格', '价钱', '费用', 'price', 'pricing'],
  ['速度', '性能', 'latency', 'performance', '快慢'],
  ['安装', 'install', '部署依赖', 'setup'],
];

/** 查询扩展：原 token + 命中同义词组的扩展 token（上界 20 防查询爆炸） */
export function expandQuery(text) {
  const toks = tokenize(text);
  if (!toks.length) return toks;
  const lower = String(text ?? '').toLowerCase();
  const extra = new Set();
  for (const group of SYNONYM_GROUPS) {
    if (group.some((w) => lower.includes(w.toLowerCase()))) {
      for (const w of group) for (const t of tokenize(w)) if (!toks.includes(t)) extra.add(t);
    }
  }
  return [...toks, ...[...extra].slice(0, 20)];
}

/** ---------- BM25（k1=1.5, b=0.75） ---------- */
export class BM25Index {
  constructor(docs = []) {
    this.docTokens = new Map(); // id -> tokens
    this.df = new Map();        // token -> doc count
    this.postings = new Map();  // token -> Set<id>（倒排：召回与查询共享 token 的文档）
    this.totalLen = 0;          // 增量维护（避免每次 add 全量重算 avgLen 的 O(N²)）
    this.avgLen = 0;
    for (const { id, text } of docs) this.add(id, text);
  }

  add(id, text) {
    if (this.docTokens.has(id)) this.remove(id); // 同 id 重复写入：先移除旧文档再重建
    const tokens = tokenize(text);
    this.docTokens.set(id, tokens);
    for (const t of new Set(tokens)) {
      this.df.set(t, (this.df.get(t) ?? 0) + 1);
      if (!this.postings.has(t)) this.postings.set(t, new Set());
      this.postings.get(t).add(id);
    }
    this.totalLen += tokens.length;
    this.avgLen = this.docTokens.size ? this.totalLen / this.docTokens.size : 0;
  }

  remove(id) {
    const tokens = this.docTokens.get(id);
    if (!tokens) return;
    for (const t of new Set(tokens)) {
      const c = this.df.get(t) ?? 1;
      if (c <= 1) { this.df.delete(t); this.postings.delete(t); }
      else { this.df.set(t, c - 1); this.postings.get(t)?.delete(id); }
    }
    this.docTokens.delete(id);
    this.totalLen -= tokens.length;
    this.avgLen = this.docTokens.size ? this.totalLen / this.docTokens.size : 0;
  }

  /** 返回原始 BM25 分（无界） */
  score(queryTokens, docTokens) {
    const k1 = 1.5, b = 0.75;
    const N = this.docTokens.size || 1;
    const tf = new Map();
    for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const dl = docTokens.length || 1;
    let s = 0;
    for (const t of queryTokens) {
      const f = tf.get(t);
      if (!f) continue;
      const n = this.df.get(t) ?? 0;
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / (this.avgLen || dl)));
    }
    return s;
  }

  /** top-K 检索：倒排召回共享 token 的候选再打分（O(命中集) 而非 O(全库)），返回 [{id, score}]，score 归一到 [0,1]
   *  查询走 expandQuery（同义词扩展）：跨说法召回（"省钱" ↔ "成本优化"） */
  search(queryText, topK = 8) {
    const q = expandQuery(queryText);
    if (!q.length || this.docTokens.size === 0) return [];
    const cand = new Set();
    for (const t of q) {
      const ids = this.postings.get(t);
      if (ids) for (const id of ids) cand.add(id);
    }
    const out = [];
    for (const id of cand) {
      const s = this.score(q, this.docTokens.get(id));
      if (s > 0) out.push({ id, score: s / (s + 3) });
    }
    out.sort((a, b2) => b2.score - a.score);
    return out.slice(0, topK);
  }
}

/** ---------- 候选预筛：倒排索引召回共享 ≥2 个 token 的对（避免 O(n²) 全比对） ---------- */
export function candidatePairs(texts) {
  // texts: [{id, text}]
  const index = new Map(); // token -> Set<id>
  const tokensOf = new Map();
  for (const { id, text } of texts) {
    const toks = tokenize(text);
    tokensOf.set(id, toks);
    for (const t of new Set(toks)) {
      if (!index.has(t)) index.set(t, new Set());
      index.get(t).add(id);
    }
  }
  const pairCount = new Map(); // "a|b" (a<b 字典序) -> 共享 token 数
  for (const ids of index.values()) {
    if (ids.size < 2 || ids.size > 50) continue; // 高频 token（如停用残留）无区分度，跳过
    const arr = [...ids];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = arr[i] < arr[j] ? `${arr[i]}|${arr[j]}` : `${arr[j]}|${arr[i]}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  const out = [];
  for (const [key, shared] of pairCount) {
    if (shared < 2) continue; // 至少共享 2 个 token 才值得精算
    const [a, b] = key.split('|');
    const ja = jaccard(tokensOf.get(a) ?? [], tokensOf.get(b) ?? []);
    if (ja > 0) out.push({ a, b, jaccard: ja });
  }
  out.sort((x, y) => y.jaccard - x.jaccard);
  return out;
}

/** Jaccard 相似度（基于 token 集合） */
export function jaccard(tokensA, tokensB) {
  const A = new Set(tokensA), B = new Set(tokensB);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
