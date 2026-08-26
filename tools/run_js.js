// tools/run_js.js —— JavaScript 受信执行（全功能模式：Node 内置模块全开放）
// 信任模型：无 vm 隔离、无逃逸黑名单——LLM 代码可 require 任意 Node 内置模块（fs/http/child_process 等），
// 打开网页、读写文件、发起网络请求均可行；第三方 npm 包不可用（零依赖产品边界）。
// 可靠性护栏保留：Worker 进程级超时硬终止 + 内存封顶（防死循环/内存炸弹拖垮宿主，属资源护栏而非权限沙箱）。
import { Worker } from 'node:worker_threads';

// Worker 引导源（eval 模式 CJS）：vm 直跑保留尾表达式语义；require 白名单 = Node 内置模块
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { runInNewContext } = require('node:vm');
const { builtinModules } = require('node:module');
const _st = setTimeout, _ct = clearTimeout, _si = setInterval, _ci = clearInterval;
const logs = [];
let pendingTimers = 0, asyncErr = null;
function fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v)?.slice(0, 500) ?? String(v); } catch { return String(v); }
}
const console = {
  log: (...a) => { if (logs.length < 50) logs.push(a.map(fmt).join(' ')); },
  error: (...a) => { if (logs.length < 50) logs.push('ERR ' + a.map(fmt).join(' ')); },
  warn: (...a) => { if (logs.length < 50) logs.push('WARN ' + a.map(fmt).join(' ')); },
};
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
// 内置模块白名单 require：fs/http/child_process/os/path 等全部可用，第三方包明确报错
const requireBuiltin = (name) => {
  const bare = String(name).replace(/^node:/, '');
  if (!builtinModules.includes(bare)) throw new Error('只允许 require Node 内置模块（可带 node: 前缀），第三方包不可用：' + name);
  return require('node:' + bare);
};
// process 安全子集：保留平台/环境信息（打开浏览器要判平台），去掉 exit/kill（防 LLM 代码误杀宿主进程）
const processLite = {
  platform: process.platform, arch: process.arch, version: process.version,
  cwd: () => process.cwd(), hrtime: process.hrtime.bigint.bind(process.hrtime), uptime: process.uptime,
  env: { ...process.env }, argv: ['node', 'run_js'], execPath: process.execPath,
};
const ctx = {
  console, require: requireBuiltin, process: processLite,
  setTimeout: limitedSetTimeout, clearTimeout: _ct, setInterval: limitedSetInterval, clearInterval: _ci,
  fetch: (...a) => fetch(...a), Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController,
  Math, JSON, Date, Number, String, Array, Object, Boolean, Map, Set, WeakMap, WeakSet,
  RegExp, Error, TypeError, RangeError, BigInt, Symbol, Promise, parseInt, parseFloat,
  isNaN, isFinite, structuredClone, encodeURIComponent, decodeURIComponent,
  performance, queueMicrotask, crypto: globalThis.crypto,
};
(async () => {
  let result, err = null;
  // 先直接执行（脚本完成值 = 尾表达式，保留隐式返回）；仅当遇到 top-level await 语法错误才包 async 块重跑
  try {
    result = runInNewContext(workerData.code, ctx, { timeout: workerData.syncTimeoutMs, filename: 'run_js.vm.js' });
    if (result && typeof result.then === 'function') result = await result;
  } catch (e) {
    if (/await is only valid|Unexpected identifier|Unexpected token/i.test(String(e?.message))) {
      try {
        result = await runInNewContext('(async()=>{' + String.fromCharCode(10) + workerData.code + String.fromCharCode(10) + '})()', ctx, { timeout: workerData.syncTimeoutMs, filename: 'run_js.vm.js' });
      } catch (e2) { err = e2?.message ?? String(e2); }
    } else err = e?.message ?? String(e);
  }
  const t0 = Date.now();
  while (pendingTimers > 0 && Date.now() - t0 < 2500) await new Promise((ok) => _st(ok, 25));
  parentPort.postMessage({ logs, result: result === undefined ? undefined : fmt(result), err: err || (asyncErr ? String(asyncErr?.message ?? asyncErr) : null) });
})().catch((e) => parentPort.postMessage({ logs, err: 'worker 内部错误：' + (e?.message ?? String(e)) }));
`;

export default {
  name: 'run_js',
  desc: '运行 JavaScript 代码并返回 console 输出与返回值（全功能模式：可 require 任意 Node 内置模块——fs 读写文件、fetch/http 网络请求、child_process 打开网页/调系统命令、os/path 等；参数：{"code":"const os=require(\'node:os\');console.log(os.platform())","timeoutMs":15000}；打开网页示例：require(\'node:child_process\').exec(darwin?\'open\':win32?\'start\':\'xdg-open\' + \' https://example.com\')；无第三方 npm 包，进程级超时硬终止 + 内存封顶）',
  risk: 'medium',
  checkPermissions: (p) => {
    if (typeof p.code !== 'string' || !p.code.trim()) return { ok: false, reason: 'code 必填（JavaScript 源码字符串）' };
    if (p.code.length > 20_000) return { ok: false, reason: '代码过长（≤20KB）' };
    if (p.timeoutMs != null && (!Number.isFinite(Number(p.timeoutMs)) || Number(p.timeoutMs) < 1000 || Number(p.timeoutMs) > 60_000)) {
      return { ok: false, reason: 'timeoutMs 须为 1000-60000 毫秒' };
    }
    return { ok: true };
  },
  run: (p) => new Promise((resolve) => {
    let settled = false;
    const hardMs = Math.min(Math.max(Number(p.timeoutMs) || 10_000, 1000), 60_000);
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
        workerData: { code: p.code, syncTimeoutMs: hardMs },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 }, // 内存炸弹封顶
      });
    } catch (e) {
      resolve(`错误：worker 启动失败 ${String(e?.message ?? e).slice(0, 200)}`);
      return;
    }
    const timer = setTimeout(() => finish(`错误：执行超时（${Math.round(hardMs / 1000)}s 硬终止——代码可能包含死循环或不可完成的等待，可用 timeoutMs 参数放宽至最多 60s）`), hardMs);
    w.on('message', (m) => {
      const parts = [];
      if (m.logs?.length) parts.push(`输出：\n${m.logs.join('\n').slice(0, 2000)}`);
      if (m.result !== undefined) parts.push(`返回值：${String(m.result).slice(0, 1000)}`);
      if (m.err) parts.push(`错误：${String(m.err).slice(0, 300)}`);
      // 数值健全性哨兵：输出全为 null/NaN 数值通常意味着计算 bug（JSON.stringify 把 NaN 写成 null），
      // 提示重试链修正代码而非把 null 当有效结果写进交付物
      const text = parts.join('\n');
      if (/"monthly|"total|"revenue|"sum|"avg|"count/.test(text) && /:\s*(null|NaN)\b/.test(text) && !m.err) {
        parts.push('⚠ 数值健全性警告：输出中的数值字段为 null/NaN——常见原因是算式对缺失字段做算术（undefined*5=NaN，JSON.stringify 序列化为 null）。请检查字段名拼写与条件分支（如 p.seats?p.users:… 的判断字段可能不存在）');
      }
      finish(parts.join('\n') || '(无输出，代码执行完毕)');
    });
    w.on('error', (e) => finish(`错误：${String(e?.message ?? e).slice(0, 300)}`));
    w.on('exit', (code) => { if (code !== 0 && !settled) finish('错误：worker 异常退出（可能触发资源上限）'); });
  }),
};
