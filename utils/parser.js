// utils/parser.js —— LLM 结构化容错解析（§4.2.1 结构化输出管线的轻量实现）
// 原始输出 → 提取 JSON → 容错修复 → 形状校验；失败返回 null，调用方必须显式处理 null。

/** 从 LLM 文本中提取 JSON：优先 ```json 围栏，其次首个平衡的 {} / [] 块 */
export function extractJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const c of candidates) {
    const direct = tryParse(repair(c));
    if (direct !== null && typeof direct === 'object') return direct;
    const scanned = scanBalanced(c);
    if (scanned !== null) return scanned;
  }
  return null;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** 容错修复：尾逗号、中文引号包裹的键值、单引号字符串（轻量，不做深度修复） */
function repair(s) {
  return s
    .replace(/，/g, ',').replace(/：/g, ':')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/^\uFEFF/, '');
}

/** 扫描首个平衡的对象/数组块（应对 JSON 前后夹杂解释文字） */
function scanBalanced(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const stack = [];
  let inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) { end = i; break; }
    }
  }
  if (end > 0) return tryParse(repair(text.slice(start, end + 1)));
  // 截断容错：按括号栈补齐闭合符（去掉悬空的尾逗号/残缺键值）
  let patched = text.slice(start).replace(/,\s*$/, '');
  patched = patched.replace(/[,\[]\s*"[^"\]]*$/, (m) => (m.startsWith('[') ? '[' : ',')); // 残缺尾项剔除
  for (let k = stack.length - 1; k >= 0; k--) patched += stack[k];
  return tryParse(repair(patched));
}

/**
 * 校验并归一：validate(value) 返回 null 表示通过，否则返回错误字符串。
 * 返回 { ok: true, value } 或 { ok: false, error }。
 */
export function validateShape(value, validate) {
  if (value === null || value === undefined) return { ok: false, error: '输出不含 JSON' };
  const err = validate(value);
  if (err) return { ok: false, error: err };
  return { ok: true, value };
}

/** 常用断言助手 */
export const is = {
  nonEmptyStr: (v) => (typeof v === 'string' && v.trim().length > 0 ? null : '须为非空字符串'),
  num: (v) => (typeof v === 'number' && Number.isFinite(v) ? null : '须为数字'),
  arr: (v) => (Array.isArray(v) && v.length >= 0 ? null : '须为数组'),
};
