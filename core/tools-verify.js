// core/tools-verify.js —— 多规则断言器（一次调用，零 token）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function runVerify(args, workspace) {
  const { rules, file, text, base64 } = args ?? {};
  if (!rules || !Array.isArray(rules) || rules.length === 0) throw new Error('rules 必传，且须为非空数组');
  if (!file && !text && !base64) throw new Error('须传 file 或 text 或 base64');
  const results = [];
  for (const rule of rules) {
    const r = _evalOne(rule, file, text, base64, workspace);
    results.push(r);
  }
  const passAll = results.every((r) => r.pass);
  const summary = { passAll, total: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length };
  return JSON.stringify({ ...summary, details: results }, null, 2);
}
function _evalOne(rule, file, text, base64, workspace) {
  const type = rule.type ?? 'contains';
  const target = base64 ? _fromBase64(base64) : (text ?? (file ? _readFile(file, workspace) : ''));
  if (target === undefined) return { type: rule.type, pass: false, message: '数据源为空' };
  try {
    switch (type) {
      case 'exists': return { type, pass: !!target, message: target ? '存在' : '内容为空' };
      case 'contains': return { type, pass: target.includes(rule.value), message: rule.value };
      case 'regex': {
        const re = new RegExp(rule.value);
        return { type, pass: re.test(target), message: re.source };
      }
      case 'json_valid': {
        try { JSON.parse(target); return { type, pass: true, message: 'valid JSON' }; }
        catch { return { type, pass: false, message: `JSON 解析失败: ${rule.value}` }; }
      }
      case 'min_length': return { type, pass: target.length >= (rule.value ?? 0), message: `length=${target.length} >= ${rule.value}` };
      case 'max_length': return { type, pass: target.length <= (rule.value ?? Infinity), message: `length=${target.length} <= ${rule.value}` };
      case 'eq': return { type, pass: target.trim() === String(rule.value).trim(), message: target.trim() };
      case 'not_contains': return { type, pass: !target.includes(rule.value), message: rule.value };
      case 'file_exists': return { type, pass: existsSync(_resolvePath(rule.value, workspace)), message: rule.value };
      case 'line_count': {
        const lines = target.split('\n').length;
        const op = rule.op ?? '==', n = Number(rule.value);
        let pass;
        if (op === '==') pass = lines === n;
        else if (op === '>=') pass = lines >= n;
        else if (op === '<=') pass = lines <= n;
        else if (op === '>') pass = lines > n;
        else if (op === '<') pass = lines < n;
        return { type, pass, actual: lines, expected: `${op}${n}`, message: `${lines} ${op} ${n}` };
      }
      default: throw new Error(`未知断言类型：${type}`);
    }
  } catch (e) { return { type, pass: false, message: `异常: ${e.message}` }; }
}
function _readFile(file, workspace) {
  if (!file) return undefined;
  const p = _resolvePath(file, workspace);
  if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
  return readFileSync(p, 'utf8');
}
function _resolvePath(file, workspace) {
  if (file.startsWith('/')) return file;
  return join(workspace ?? process.cwd(), file);
}
function _fromBase64(s) {
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return undefined; }
}
