// tools/run_js.js —— JavaScript 沙箱执行（写码任务可运行验证）
// 安全：vm 隔离上下文（无 require/process/fs/fetch）、3 秒超时、代码长度限制、危险模式黑名单。
import { runInNewContext } from 'node:vm';

export default {
  name: 'run_js',
  desc: '运行 JavaScript 代码片段并返回 console 输出与返回值（参数：{"code":"const a=[1,2,3];console.log(a.map(x=>x*x))"}；纯计算/逻辑/数据验证用，无文件与网络访问，3 秒超时）',
  risk: 'medium',
  checkPermissions: (p) => {
    if (typeof p.code !== 'string' || !p.code.trim()) return { ok: false, reason: 'code 必填（JavaScript 源码字符串）' };
    if (p.code.length > 10_000) return { ok: false, reason: '代码过长（≤10KB）' };
    if (/require\s*\(|\bimport\s|\bexport\s|process\.|globalThis|global\.|Function\s*\(|eval\s*\(|WebAssembly|Reflect\.construct|constructor|__proto__|prototype\s*\[|importScripts|fetch\s*\(/i.test(p.code)) {
      return { ok: false, reason: '禁止 require/import/process/eval/Function/fetch/constructor 等逃逸模式' };
    }
    return { ok: true };
  },
  run: (p) => new Promise((resolve) => {
    const logs = [];
    const sandbox = {
      console: {
        log: (...a) => { if (logs.length < 30) logs.push(a.map(fmt).join(' ')); },
        error: (...a) => { if (logs.length < 30) logs.push('ERR ' + a.map(fmt).join(' ')); },
        warn: (...a) => { if (logs.length < 30) logs.push('WARN ' + a.map(fmt).join(' ')); },
      },
      Math, JSON, Date, Number, String, Array, Object, Boolean, Map, Set, WeakMap, WeakSet,
      RegExp, Error, TypeError, RangeError, BigInt, Symbol, Promise, parseInt, parseFloat,
      isNaN, isFinite, structuredClone, encodeURIComponent, decodeURIComponent,
      TextEncoder, TextDecoder,
    };
    function fmt(v) {
      if (typeof v === 'string') return v;
      try { return JSON.stringify(v)?.slice(0, 500) ?? String(v); } catch { return String(v); }
    }
    let result, err = null;
    try {
      result = runInNewContext(p.code, sandbox, { timeout: 3000, filename: 'run_js.vm.js' });
    } catch (e) { err = e.message ?? String(e); }
    const parts = [];
    if (logs.length) parts.push(`输出：\n${logs.join('\n').slice(0, 2000)}`);
    if (result !== undefined) {
      const rs = typeof result === 'object' ? (() => { try { return JSON.stringify(result); } catch { return String(result); } })() : String(result);
      parts.push(`返回值：${rs.slice(0, 1000)}`);
    }
    if (err) parts.push(`错误：${err.slice(0, 300)}`);
    resolve(parts.join('\n') || '(无输出，代码执行完毕)');
  }),
};
