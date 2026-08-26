// core/tools-query.js —— 结构化数据提取（省 token）：JSON 点路径 / CSV 条件筛选
import { readFileSync, existsSync } from 'node:fs';
export function runQuery(args) {
  const { source, path, where, column, limit = 100 } = args ?? {};
  if (!source) throw new Error('source 必填（JSON 字符串或文件路径）');
  let raw;
  try {
    if (existsSync(source) && !source.startsWith('{')) {
      raw = readFileSync(source, 'utf8');
    } else { raw = source; }
  } catch { raw = source; }
  let data;
  try { data = JSON.parse(String(raw)); } catch (e) { throw new Error(`JSON 解析失败：${e.message}`); }
  if (path) {
    const val = getAtPath(data, String(path));
    const arr = Array.isArray(val) ? val : [val];
    return JSON.stringify(arr.slice(0, Number(limit)), null, 2).slice(0, 8000);
  }
  if (where) {
    // CSV-like 筛选：source 为文件名时按逗号解析；否则视为 object[]
    let rows = Array.isArray(data) ? data : (data.rows ?? []);
    if (!rows.length && typeof data === 'object' && !Array.isArray(data)) {
      rows = [data];
    }
    const filtered = rows.filter((r) => matchesWhere(r, where));
    const out = column ? filtered.map((r) => Object.fromEntries(column.split(',').map((c) => [c.trim(), r[c.trim()]]))).slice(0, Number(limit)) : filtered.slice(0, Number(limit));
    return JSON.stringify(out, null, 2).slice(0, 8000);
  }
  return JSON.stringify(data, null, 2).slice(0, 8000);
}
function getAtPath(obj, path) {
  const parts = String(path).replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    const m = p.match(/^(\w+)\[(\d+)\]$/);
    if (m) cur = cur[m[1]]?.[Number(m[2])];
    else cur = cur[p];
  }
  return cur;
}
function matchesWhere(row, where) {
  // 简单格式：col op val，op ∈ {==,!=,>,<,>=,<=,contains,like}
  const re = /([A-Za-z_][\w.]*)\s*(==|!=|>=|<=|>|<|contains|like)\s*(.+)/;
  const m = String(where).match(re);
  if (!m) return true;
  const [, col, op, val] = m;
  const cell = String(row[col] ?? '');
  switch (op) {
    case '==': return cell === val;
    case '!=': return cell !== val;
    case '>': return Number(cell) > Number(val);
    case '<': return Number(cell) < Number(val);
    case '>=': return Number(cell) >= Number(val);
    case '<=': return Number(cell) <= Number(val);
    case 'contains': return cell.includes(val);
    case 'like': return new RegExp(val.replace(/[.+?*^$(){}|]/g, '\\$&')).test(cell);
    default: return true;
  }
}
