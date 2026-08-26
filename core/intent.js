// core/intent.js —— 意图契约闭环（B1，吸收 dual-agent v0.9.14 设计）
// 病根：长任务后段上下文膨胀，任务原文被埋进历史，交付漏项（要求 3 个文件只写 2 个、
// 对比维度缺一个）。todo 治步骤执行，意图契约治"要求覆盖"。
// 闭环：任务前抽取契约 → 每步注记防遗忘 → 交付前硬断言 + judge 核验 → 缺口返修（≤2 轮）
// 设计纪律：
// 1. judge 只标具体可查的缺口（文件缺失/问题未答/维度缺失），禁止风格判断（v0.9.4 教训）
// 2. 返修轮计入预算、上限 2 轮，防完美主义死循环（v0.9.10 教训）
// 3. 全链路优雅降级：抽取失败/判定解析失败一律按"无契约/通过"处理，特性不构成硬依赖
import { existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { chatJson } from './llm-adapter.js';

/** 意图抽取闸门：仅交付物型任务启用（问答型任务零开销——白吃一次 LLM 配额） */
export function intentWorthy(input) {
  const s = String(input ?? '');
  if (s.length < 16) return false;
  return /写|生成|创建|保存|输出|制作|整理|报告|清单|对比|分别|以及|同时|\.md|\.json|\.txt|\.csv|文件|文档/.test(s);
}

/** 路径归一：绝对路径/带前缀路径 → 相对工作区根目录 */
export function normalizePath(rawPath, wsDir) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  let p = rawPath.trim().replace(/\\/g, '/');
  if (!p || p === 'null') return null;
  if (wsDir && p.startsWith(wsDir.replace(/\\/g, '/'))) {
    p = p.slice(wsDir.length);
    if (p.startsWith('/')) p = p.slice(1);
  }
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p)) {
    const base = p.split('/').filter(Boolean).pop() ?? '';
    return base.length > 1 ? base : null;
  }
  return p.slice(0, 200) || null;
}

/** 契约归一 + 防御：字段缺失/类型错剔除，超限截断；全空返回 null */
export function normalizeIntent(raw, wsDir) {
  if (!raw || typeof raw !== 'object') return null;
  const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 200)) : []);
  const deliverables = (Array.isArray(raw.deliverables) ? raw.deliverables : [])
    .filter((d) => d && typeof d === 'object')
    .slice(0, 6)
    .map((d) => ({
      path: normalizePath(d.path, wsDir),
      criterion: typeof d.criterion === 'string' ? d.criterion.trim().slice(0, 300) : '',
    }));
  const intent = {
    task: typeof raw.task === 'string' ? raw.task.trim().slice(0, 200) : '',
    goals: strArr(raw.goals).slice(0, 3),
    deliverables,
    constraints: strArr(raw.constraints).slice(0, 5),
    acceptance: strArr(raw.acceptance).slice(0, 5),
  };
  if (!intent.task && !intent.goals.length && !intent.deliverables.length && !intent.acceptance.length) return null;
  return intent;
}

/** 抽取意图契约（失败返回 null：任务照旧执行，意图闭环不构成硬依赖） */
export async function extractIntent(input, { label, wsDir } = {}) {
  const schema = '{"task":"一句话概述","goals":["目标，≤3条"],"deliverables":[{"path":"产出文件路径（相对工作区根目录），非文件交付物为 null","criterion":"验收标准"}],"constraints":["约束条件"],"acceptance":["可客观核验的验收条款，≤5条"]}';
  const raw = await chatJson({
    messages: [
      { role: 'system', content: '你是需求分析器，只输出 JSON。' },
      { role: 'user', content: `把下面的任务解析为结构化意图契约 JSON，规则：\n1) 只依据任务原文，禁止脑补任务没提的要求；\n2) deliverables 覆盖全部产出物（文件/答案/结论），纯问答类为空数组；\n3) acceptance 每条必须可客观核验（存在性/内容包含/问题已答），禁止"质量好"类模糊条款；\n4) goals ≤3 条、acceptance ≤5 条。\n输出格式：${schema}\n\n任务原文：\n${String(input).slice(0, 4000)}` },
    ],
    validate: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? null : '须为 JSON 对象'),
    label,
  }).catch(() => null);
  return normalizeIntent(raw, wsDir);
}

/** 每步注记（注入发送副本，落盘干净）：执行全程对照的权威要求来源 */
export function formatIntentNote(intent) {
  if (!intent) return '';
  const lines = ['[意图契约] 任务交付要求（执行全程对照，交付前逐条自查）：'];
  if (intent.task) lines.push(`概述：${intent.task}`);
  for (const d of intent.deliverables) lines.push(`- 交付物：${d.path || '（非文件）'}${d.criterion ? `——${d.criterion}` : ''}`);
  for (const a of intent.acceptance) lines.push(`- 验收：${a}`);
  for (const c of intent.constraints) lines.push(`- 约束：${c}`);
  lines.push('注意：最近上下文可能被折叠，本注记是任务要求的权威来源；遗漏任何一条即交付不合格。');
  return lines.slice(0, 16).join('\n');
}

/** 硬断言：文件类交付物存在性检查（框架判定，零 LLM 成本） */
export function assertDeliverables(intent, wsDir) {
  const results = [];
  for (const d of intent?.deliverables ?? []) {
    if (!d.path) continue;
    const abs = isAbsolute(d.path) ? d.path : join(wsDir, d.path);
    const ok = existsSync(abs);
    results.push(`${ok ? 'PASS' : 'FAIL'} ${d.path}${d.criterion ? `（${d.criterion}）` : ''}`);
  }
  return results;
}

/** judge 提示：只标具体可查的缺口，禁止风格判断 */
function buildJudgePrompt(intent, finalAnswer, hardResults) {
  return `你是交付核验裁判。对照意图契约逐条核验最终交付，输出 JSON：\n{"verdict":"PASS 或 GAPS","gaps":["缺口描述，仅当 verdict=GAPS"]}\n核验纪律：\n1) 只标具体可查的缺口：要求的文件不存在、明确的问题没有回答、任务要求的维度/条目缺失；\n2) 禁止风格与口味判断（措辞/详略/格式偏好不算缺口）；\n3) 硬断言已 FAIL 的项直接列入 gaps（无需重复判断）；\n4) 全部满足输出 PASS；拿不准的项按满足处理（验证器误报比漏报更有害）。\n\n意图契约：\n${JSON.stringify(intent, null, 1)}\n\n硬断言结果（框架判定）：\n${hardResults?.length ? hardResults.join('\n') : '（无文件类交付物）'}\n\n最终交付内容：\n${String(finalAnswer ?? '').slice(0, 6000)}`;
}

/** 判定解析：垃圾输出按 PASS 处理（false-positive 缺口比 false-negative 更有害——返修烧轮数） */
export function parseVerdict(text) {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return { verdict: 'PASS', gaps: [] };
  let v = null;
  try { v = JSON.parse(s.slice(start, end + 1)); } catch { return { verdict: 'PASS', gaps: [] }; }
  const gaps = (Array.isArray(v.gaps) ? v.gaps : [])
    .filter((g) => typeof g === 'string' && g.trim())
    .map((g) => g.trim().slice(0, 300))
    .slice(0, 6);
  return v.verdict === 'GAPS' && gaps.length ? { verdict: 'GAPS', gaps } : { verdict: 'PASS', gaps: [] };
}

/** 交付核验（judge）：硬断言 FAIL 项直通 gaps，其余 LLM 核验 */
export async function judgeDelivery(intent, answer, hardResults, { label } = {}) {
  const hardFails = (hardResults ?? []).filter((r) => r.startsWith('FAIL')).map((r) => `要求的交付物未落实：${r.slice(5)}`);
  const { chat } = await import('./llm-adapter.js');
  const text = await chat({
    messages: [
      { role: 'system', content: '你是交付核验裁判，只输出 JSON。' },
      { role: 'user', content: buildJudgePrompt(intent, answer, hardResults) },
    ],
    temperature: 0, label,
  }).then((r) => r.text).catch(() => '');
  const v = parseVerdict(text);
  const gaps = [...new Set([...hardFails, ...v.gaps])].slice(0, 6);
  return gaps.length ? { verdict: 'GAPS', gaps } : { verdict: 'PASS', gaps: [] };
}
