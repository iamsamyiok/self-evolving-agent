// core/tools-verify.js —— 多规则断言器（一次调用，零 token）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function runVerify(args, workspace) {
  let { rules, file, text, base64 } = args ?? {};
  if (!rules || !Array.isArray(rules) || rules.length === 0) throw new Error('rules 必传，且须为非空数组');
  // file_exists 类规则不需要数据源（断言的是规则自身路径）；其余规则必须有 file/text/base64 之一
  const needsSource = rules.some((r) => (r?.type ?? 'contains') !== 'file_exists');
  let autoFile = null; // 数据源是否来自自动推断（决定文件缺失时的报错形态）
  if (needsSource && file == null && text == null && base64 == null) {
    // 自然用法兜底：「文件存在且内容包含X」混合规则未显式传 file 时，用 file_exists 的路径做断言对象
    // （planner 高频参数形态；文件不存在时走结构化 pass:false 而非 throw——断言失败本就是结果而非异常）
    const fePath = rules.find((r) => r?.type === 'file_exists')?.value;
    if (fePath != null) { file = String(fePath); autoFile = file; }
    else throw new Error('须传 file 或 text 或 base64');
  }
  const results = [];
  for (const rule of rules) {
    const r = _evalOne(rule, file, text, base64, workspace, autoFile);
    results.push(r);
  }
  const passAll = results.every((r) => r.pass);
  const summary = { passAll, total: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length };
  return JSON.stringify({ ...summary, details: results }, null, 2);
}
function _evalOne(rule, file, text, base64, workspace, autoFile) {
  const type = rule.type ?? 'contains';
  const target = base64 ? _fromBase64(base64) : (text ?? (file ? _readFile(file, workspace, autoFile) : ''));
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
        // 去掉末尾单个换行再数行，避免 "a\nb\n" 数出 3 行（尾随换行产生的幻影空行）
        const lines = target.replace(/\n$/, '').split('\n').length;
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
function _readFile(file, workspace, autoFile) {
  if (!file) return undefined;
  const p = _resolvePath(file, workspace);
  if (!existsSync(p)) {
    // 自动推断的数据源文件缺失：返回空内容让各规则报 pass:false（file_exists 规则自身会给出路径级失败详情）；
    // 显式指定 file 却不存在仍抛错（调用方明确要读此文件，静默空串会掩盖路径写错）
    if (autoFile) return '';
    throw new Error(`文件不存在：${p}`);
  }
  return readFileSync(p, 'utf8');
}
function _resolvePath(file, workspace) {
  if (file.startsWith('/')) return file;
  return join(workspace ?? process.cwd(), file);
}
function _fromBase64(s) {
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return undefined; }
}
