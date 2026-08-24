// tools/calc.js —— 数学计算器（LLM 算术不可靠，数值任务走本工具）
// 热插拔约定：default 导出 { name, desc, risk, checkPermissions, run }
export default {
  name: 'calc',
  desc: '精确数学计算（参数：{"expr":"2^10 + sqrt(144) * 3.5"}；支持四则/幂/开方/三角/对数/取整）',
  risk: 'low',
  checkPermissions: (p) => {
    if (typeof p.expr !== 'string' || !p.expr.trim()) return { ok: false, reason: 'expr 必填（数学表达式字符串）' };
    if (p.expr.length > 500) return { ok: false, reason: '表达式过长' };
    return { ok: true };
  },
  run: async (p) => {
    const raw = p.expr.replace(/\s+/g, '');
    // 白名单字符集：数字/运算符/括号/点/逗号 + 允许的函数名与常量（其余字符一律拒绝，防代码注入）
    const stripped = raw.replace(/(sqrt|cbrt|sin|cos|tan|asin|acos|atan|log2|log10|log|ln|abs|pow|min|max|round|floor|ceil|exp|PI|E)/gi, '0');
    if (!/^[0-9+\-*/^().,%!]+$/.test(stripped)) {
      throw new Error(`表达式含不允许的字符：${raw}`);
    }
    // BigInt 精确路径：含幂运算的纯整数表达式（2^64 这类大数 double 会丢精度）
    const hasFunc = stripped.length !== raw.length;
    if (!hasFunc && !raw.includes('.') && raw.includes('^')) {
      const bigExpr = raw.replace(/\^/g, '**').replace(/\d+/g, (m) => `${m}n`);
      const fnB = new Function(`"use strict"; return (${bigExpr});`);
      const rb = fnB();
      if (typeof rb === 'bigint') return `${p.expr} = ${rb.toString()}`;
    }
    const jsExpr = raw.replace(/\^/g, '**');
    const fn = new Function(`"use strict";
      const {sqrt,cbrt,sin,cos,tan,asin,acos,atan,log2,log10,log,abs,pow,min,max,round,floor,ceil,exp,PI,E} = Math;
      const ln = Math.log;
      return (${jsExpr});`);
    const r = fn();
    if (typeof r !== 'number' || !Number.isFinite(r)) throw new Error(`计算结果无效：${r}`);
    const rounded = Math.abs(r - Math.round(r * 1e10) / 1e10) < 1e-12 ? String(Math.round(r * 1e10) / 1e10) : r.toPrecision(12).replace(/0+$/, '');
    return `${p.expr} = ${rounded}`;
  },
};
