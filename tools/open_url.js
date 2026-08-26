// tools/open_url.js —— 用系统默认浏览器打开网页/本地文件（跨平台：macOS open / Windows start / Linux xdg-open）
// 安全边界：spawn 定值命令 + 参数数组（无 shell 拼接，URL 注入无效）；仅接受 http(s) URL 与绝对路径；
// 无桌面环境（服务器/容器/SSH）时优雅降级——返回诊断与替代建议，不判失败。
import { spawn } from 'node:child_process';

const OPENER = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';

function openerArgs(target) {
  if (process.platform === 'win32') return ['/c', 'start', '', target];
  return [target];
}

function validTarget(t) {
  const s = String(t ?? '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/') && !/\s/.test(s)) return s; // 本地绝对路径
  return null;
}

export default {
  name: 'open_url',
  desc: '用系统默认浏览器打开网页或本地文件（参数：{"url":"https://example.com"} 或本地绝对路径；跨平台自动选择 open/start/xdg-open；服务器无图形界面时返回诊断与替代方案，不算失败）',
  risk: 'medium',
  checkPermissions: (p) => {
    const t = validTarget(p.url ?? p.target ?? p.path);
    if (!t) return { ok: false, reason: 'url 必填（http/https 网址，或以 / 开头且不含空格的本地绝对路径）' };
    return { ok: true };
  },
  run: (p) => new Promise((resolve) => {
    const target = validTarget(p.url ?? p.target ?? p.path);
    if (!target) { resolve('错误：url 参数不合法'); return; }
    let child;
    try {
      // 定值命令 + 参数数组：URL 中任何 shell 元字符都只是数据，无注入面
      child = spawn(OPENER, openerArgs(target), { stdio: 'ignore', detached: false });
    } catch (e) {
      resolve(`打开失败（${String(e?.message ?? e).slice(0, 120)}）。替代方案：run_js 里用 require('node:child_process') 调用系统命令，或 http_get 直接抓取页面内容。`);
      return;
    }
    let exited = false;
    child.on('error', (e) => {
      exited = true;
      const enoent = e?.code === 'ENOENT';
      resolve(enoent
        ? `当前环境（${process.platform}）没有可用的浏览器启动器（${OPENER} 不存在）——常见于服务器/容器/SSH 无桌面会话。替代方案：a) http_get 抓取页面内容给用户看 b) 把链接直接展示给用户，由用户在自己浏览器打开`
        : `打开失败（${String(e?.message ?? e).slice(0, 120)}）。替代方案：http_get 抓取页面内容，或把链接展示给用户手动打开。`);
    });
    child.on('spawn', () => {
      // 启动成功即视为交付（xdg-open 派发后退出，不等待浏览器进程生命周期）
      if (!exited) resolve(`已请求系统浏览器打开：${target}（平台 ${process.platform}，launcher=${OPENER}；若未弹出窗口请检查桌面会话/默认浏览器配置）`);
    });
    // 兜底：某些平台 spawn 成功但无 spawn 事件回调时序差异，2s 内必有结论
    setTimeout(() => { if (!exited && !child.killed) resolve(`已发起打开请求：${target}（平台 ${process.platform}）`); }, 2000);
  }),
};
