// core/research.js —— 深度研究管线（证据模型 / 多 query 并行 / 信息缺口迭代 / 步骤蒸馏）
// 设计原则：evidence 一等公民——搜索结果从"字符串流过"升级为带来源的结构化证据，
// final 综合引用证据序号，前端渲染来源卡片，经验沉淀保留"结论来自哪"的元信息。
import { chatJson } from './llm-adapter.js';
import { scanExternalContent, wrapExternal } from './inject-guard.js';

/** 搜索结果文本 → 证据条目（兼容 AnySearch 与 Google News RSS 两种输出格式）
 *  格式：`N. 标题\n   来源：x\n   链接：y\n   摘要：z`（摘要行可缺省）
 *  编号行只出现在条目起点（来源/链接/摘要行以标签开头），据此切分，不做序号连续性校验 */
export function parseSearchResults(text, phase = 'search') {
  const out = [];
  const lines = String(text ?? '').split('\n');
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(\d{1,2})\.\s*(.+)$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { title: m[2].slice(0, 120), source: '', url: '', snippet: '', phase };
    } else if (cur) {
      const s = line.match(/^来源[：:]\s*(.+)$/); if (s) { cur.source = s[1].slice(0, 60); continue; }
      const l = line.match(/^链接[：:]\s*(.+)$/); if (l) { cur.url = l[1].slice(0, 300); continue; }
      const sn = line.match(/^摘要[：:]\s*(.+)$/); if (sn) { cur.snippet = sn[1].slice(0, 200); continue; }
    }
  }
  if (cur) out.push(cur);
  return out.filter((e) => e.title && e.title !== '(无标题)');
}

/** 证据账本：去重、编号、生成引用清单（final prompt 注入）与 meta 序列化（前端渲染） */
export class EvidenceBook {
  constructor(limit = 20) {
    this.items = [];
    this.limit = limit;
    this._seen = new Set();
  }

  /** 批量收录（按 URL 去重；无 URL 按标题去重）。返回实际新增数 */
  add(entries) {
    let added = 0;
    for (const e of entries ?? []) {
      if (this.items.length >= this.limit) return added;
      const key = e.url || `t:${e.title}`;
      if (this._seen.has(key)) continue;
      this._seen.add(key);
      this.items.push({ n: this.items.length + 1, ...e });
      added++;
    }
    return added;
  }

  get size() { return this.items.length; }

  /** final prompt 的引用清单：带序号与 URL，要求模型结论标注 [n] */
  citationList() {
    if (!this.items.length) return '';
    return this.items.map((e) => `[${e.n}] ${e.title}${e.source ? `（${e.source}）` : ''}${e.url ? ` ${e.url}` : ''}${e.snippet ? `\n    摘要：${e.snippet}` : ''}`).join('\n');
  }

  /** meta 序列化（前端来源卡片；snippet 已在上游截断） */
  toJSON() {
    return this.items.map(({ n, title, source, url, snippet, phase }) => ({ n, title, source, url, snippet, phase }));
  }
}

/** 多 query 生成：LLM 从不同角度/语言拆出互补子查询（一次调用）。降级返回 null 走单 query */
export async function multiQuery(input, { label, count = 3 } = {}) {
  const out = await chatJson({
    messages: [
      { role: 'system', content: `你是检索查询设计师。把任务拆成 ${count} 条互补的搜索查询（不同角度/关键词/必要时英文），覆盖任务的不同侧面。输出 JSON：{"queries":["..."]}。每条 ≤40 字，直接可搜。` },
      { role: 'user', content: `任务：${input}` },
    ],
    validate: (v) => (!Array.isArray(v?.queries) || v.queries.length < 1 ? '须含 queries 数组' : v.queries.some((q) => typeof q !== 'string' || q.trim().length < 2) ? 'query 须为非空字符串' : null),
    label,
  }).catch(() => null);
  return (out?.queries ?? []).map((q) => String(q).trim().slice(0, 60)).filter(Boolean).slice(0, count);
}

/** 并行搜索：多 query 同时发出（AnySearch 匿名层可并发；失败单路跳过不拖垮整体） */
export async function parallelSearch(tools, queries, { label, maxResults = 6 } = {}) {
  const jobs = queries.slice(0, 3).map((query) =>
    tools.call('news_search', { query, maxResults }, { taskId: label })
      .then((r) => ({ query, text: String(r?.output ?? '').trim() }))
      .catch(() => ({ query, text: '' })),
  );
  return (await Promise.all(jobs)).filter((r) => r.text);
}

/** 信息缺口判定：证据是否足以支撑任务，缺什么（一次调用）。返回 { sufficient, gaps: [...] } */
export async function gapCheck(input, evidenceBook, { label } = {}) {
  const out = await chatJson({
    messages: [
      { role: 'system', content: '你是研究审查员。对照任务目标检查已有证据：信息是否充分覆盖任务的所有侧面？输出 JSON：{"sufficient":true} 表示已充分；{"sufficient":false,"gaps":["补搜查询1","补搜查询2"]} 表示有缺口（每条 ≤40 字、可直接搜索、最多 2 条，只列真正影响结论的关键缺口）。' },
      { role: 'user', content: `任务：${input}\n\n已有证据清单：\n${evidenceBook.citationList() || '（无）'}` },
    ],
    validate: (v) => (typeof v?.sufficient !== 'boolean' ? '须含 sufficient 布尔值' : v.sufficient === false && !Array.isArray(v.gaps) ? '不充分时须含 gaps 数组' : null),
    label,
  }).catch(() => ({ sufficient: true, gaps: [] })); // 判定失败按充分处理（不无限循环）
  if (out?.sufficient === false && Array.isArray(out.gaps)) {
    return { sufficient: false, gaps: out.gaps.map((g) => String(g).trim().slice(0, 60)).filter(Boolean).slice(0, 2) };
  }
  return { sufficient: true, gaps: [] };
}

/** 步骤蒸馏：步骤总产出超预算时一次 LLM 压缩成要点（保数字/结论/来源序号，去过程叙述） */
export async function distillSteps(steps, { label, threshold = 12_000 } = {}) {
  const total = steps.reduce((a, s) => a + String(s.output ?? '').length, 0);
  if (total <= threshold) return { distilled: false, steps };
  const out = await chatJson({
    messages: [
      { role: 'system', content: '你是研究资料蒸馏器。把多个步骤的原始产出压缩成分步骤要点：保留关键事实、数字、结论与来源序号（如 [1][2]），去掉过程叙述、重复内容与冗余措辞。输出 JSON：{"steps":[{"goal":"...","action":"...","output":"要点（≤400字）"}]}，条数与输入一致。' },
      { role: 'user', content: JSON.stringify(steps.map(({ goal, action, output }) => ({ goal, action, output: String(output).slice(0, 4000) }))) },
    ],
    validate: (v) => (!Array.isArray(v?.steps) || v.steps.length < 1 ? '须含 steps 数组' : null),
    label,
  }).catch(() => null);
  if (!out?.steps?.length) return { distilled: false, steps }; // 蒸馏失败退回原文（截断保护在调用方）
  return { distilled: true, steps: out.steps.map((s, i) => ({ goal: s.goal ?? steps[i]?.goal ?? `步骤${i + 1}`, action: s.action ?? steps[i]?.action ?? 'reason', output: String(s.output ?? '').slice(0, 600) })) };
}

/** 零 LLM 预算压缩（D1，吸收 dual-agent 上下文预算管理）：蒸馏跳过/失败时的确定性兜底。
 *  策略：总量超预算 → 从最旧步骤开始折叠为 头300+尾100+折叠标记；最近 3 步保持全文；
 *  含框架判定标记（PASS/FAIL/写入/已创建）的结果不压缩（执行依据不可丢）。
 *  返回 { compressed, steps }——未超预算原样返回 */
export function compressStepsForBudget(steps, budgetChars = 48_000) {
  const total = steps.reduce((a, s) => a + String(s.output ?? '').length, 0);
  if (total <= budgetChars) return { compressed: false, steps };
  const keepFull = new Set(steps.slice(-3).map((_, i) => steps.length - 3 + i)); // 最近 3 步全文
  steps.forEach((s, i) => {
    if (/PASS|FAIL|写入成功|已创建|已更新|已写入|断言/.test(String(s.output ?? ''))) keepFull.add(i);
  });
  const out = steps.map((s, i) => {
    const text = String(s.output ?? '');
    if (keepFull.has(i) || text.length <= 500) return s;
    const head = text.slice(0, 300);
    const tail = text.slice(-100);
    return { ...s, output: `${head}\n…［上下文预算：此步骤产出已折叠 ${text.length - 400} 字符］…\n${tail}` };
  });
  return { compressed: true, steps: out };
}

/** 搜索文本 → 注入防御包装（复用 inject-guard；缺口补搜与预检索共用） */
export function wrapSearchText(title, text) {
  const scan = scanExternalContent(text);
  return { scan, wrapped: wrapExternal(title, text, scan) };
}
