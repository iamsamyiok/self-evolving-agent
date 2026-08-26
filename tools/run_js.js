// tools/run_js.js —— JavaScript 沙箱执行（写码任务可运行验证）
// 安全：worker_threads 进程级隔离——vm timeout 只约束同步执行，microtask 中的死循环会冻结事件循环；
// 外层 Worker + 硬 terminate 兜底任何形态的卡死，resourceLimits 封顶内存。黑名单仍保留作快速失败。
import { Worker } from 'node:worker_threads';

// Worker 引导源（eval 模式 CJS）：内部再用 vm 隔离全局（无 require/process/fs/fetch）
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { runInNewContext } = require('node:vm');
const _st = setTimeout, _ct = clearTimeout, _si = setInterval, _ci = clearInterval;
const logs = [];
let pendingTimers = 0, asyncErr = null;
function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v)?.slice(0, 500) ?? String(v); } catch { return String(v); }
}
// 受限 timer：延时封顶 2s、interval 最多 20 次自动停——LLM 常写 setTimeout，缺失会 ReferenceError 假失败
const limitedSetTimeout = (fn, ms, ...a) => {
  if (typeof fn !== 'function') throw new Error('setTimeout 回调必须为函数');
  pendingTimers++;
  return _st((...aa) => { pendingTimers--; try { fn(...aa); } catch (e) { asyncErr = e; } }, Math.min(Number(ms) || 0, 2000), ...a);
};
const limitedSetInterval = (fn, ms, ...a) => {
  if (typeof fn !== 'function') throw new Error('setInterval 回调必须为函数');
  let n = 0; const id = _si(() => { try { fn(...a); } catch (e) { asyncErr = e; } if (++n >= 20) _ci(id); }, Math.min(Number(ms) || 1, 1000));
  return id;
};
const sb = {
  console: {
    log: (...a) => { if (logs.length < 30) logs.push(a.map(fmt).join(' ')); },
    error: (...a) => { if (logs.length < 30) logs.push('ERR ' + a.map(fmt).join(' ')); },
    warn: (...a) => { if (logs.length < 30) logs.push('WARN ' + a.map(fmt).join(' ')); },
  },
  setTimeout: limitedSetTimeout, clearTimeout: _ct, setInterval: limitedSetInterval, clearInterval: _ci,
  Math, JSON, Date, Number, String, Array, Object, Boolean, Map, Set, WeakMap, WeakSet,
  RegExp, Error, TypeError, RangeError, BigInt, Symbol, Promise, parseInt, parseFloat,
  isNaN, isFinite, structuredClone, encodeURIComponent, decodeURIComponent,
  TextEncoder, TextDecoder,
};
(async () => {
  let result, err = null;
  // 先直接执行（脚本完成值 = 尾表达式，保留隐式返回）；仅当遇到 top-level await 语法错误才包 async 块重跑
  // 注意：不能无条件包 (async()=>{code})() —— 块体没有隐式返回值，会丢掉尾表达式结果
  try {
    result = runInNewContext(workerData.code, sb, { timeout: 3000, filename: 'run_js.vm.js' });
    if (result && typeof result.then === 'function') result = await result; // 异步尾表达式：等待其落定（卡死由外层 Worker 硬终止兜底）
  } catch (e) {
    if (/await is only valid|Unexpected identifier|Unexpected token/i.test(String(e?.message))) {
      try {
        result = await runInNewContext('(async()=>{' + String.fromCharCode(10) + workerData.code + String.fromCharCode(10) + '})()', sb, { timeout: 3000, filename: 'run_js.vm.js' });
      } catch (e2) { err = e2?.message ?? String(e2); }
    } else err = e?.message ?? String(e);
  }
  const t0 = Date.now(); // 等 pending timer 排空（2.5s 封顶），日志才能收齐
  while (pendingTimers > 0 && Date.now() - t0 < 2500) await new Promise((ok) => _st(ok, 25));
  parentPort.postMessage({ logs, result: result === undefined ? undefined : fmt(result), err: err || (asyncErr ? String(asyncErr?.message ?? asyncErr) : null) });
})().catch((e) => parentPort.postMessage({ logs, err: '沙箱内部错误：' + (e?.message ?? String(e)) }));
`;

export default {
  name: 'run_js',
  desc: '运行 JavaScript 代码片段并返回 console 输出与返回值（参数：{"code":"const a=[1,2,3];console.log(a.map(x=>x*x))"}；纯计算/逻辑/数据验证用，无文件与网络访问，进程级隔离 + 4 秒硬超时）',
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
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate().catch(() => { /* 已退出 */ });
      resolve(out);
    };
    let w;
    try {
      w = new Worker(WORKER_SRC, {
        eval: true,
        workerData: { code: p.code },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }, // 内存炸弹封顶
      });
    } catch (e) {
      resolve(`错误：沙箱启动失败 ${String(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    const timer = setTimeout(() => finish('错误：执行超时（4s 硬终止——代码可能包含异步死循环或不可完成的等待）'), 4000);
    w.on('message', (m) => {
      const parts = [];
      if (m.logs?.length) parts.push(`输出：\n${m.logs.join('\n').slice(0, 2000)}`);
      if (m.result !== undefined) parts.push(`返回值：${String(m.result).slice(0, 1000)}`);
      if (m.err) parts.push(`错误：${String(m.err).slice(0, 300)}`);
      // 数值健全性哨兵：输出全为 null/NaN 数值通常意味着计算 bug（JSON.stringify 把 NaN 写成 null），
      // 提示重试链修正代码而非把 null 当有效结果写进交付物
      const text = parts.join('\n');
      if (/\"monthly|\"total|\"revenue|\"sum|\"avg|\"count/.test(text) && /:\s*(null|NaN)\b/.test(text) && !m.err) {
        parts.push('⚠ 数值健全性警告：输出中的数值字段为 null/NaN——常见原因是算式对缺失字段做算术（undefined*5=NaN，JSON.stringify 序列化为 null）。请检查字段名拼写与条件分支（如 p.seats?p.users:… 的判断字段可能不存在）');
      }
      finish(parts.join('\n') || '(无输出，代码执行完毕)');
    });
    w.on('error', (e) => finish(`错误：${String(e?.message ?? e).slice(0, 300)}`));
    w.on('exit', (code) => { if (code !== 0 && !settled) finish('错误：沙箱异常退出（可能触发资源上限）'); });
  }),
};
