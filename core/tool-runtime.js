// core/tool-runtime.js —— 真实工具调用体系（§9.2）+ 沙箱（§8.2）
// 纪律：声明式工具清单（名称/参数/权限级别）；高危工具默认拒绝需理由；文件限定沙箱根；网络域名白名单。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { isAbsolute, resolve, join, relative, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { CONFIG } from '../config/index.js';
import { createSkill } from './skills/create-skill.js';
import { runDiff } from './tools-diff.js';
import { runProbe } from './tools-probe.js';
import { runQuery } from './tools-query.js';
import { runStat } from './tools-stat.js';
import { runTodo } from './tools-todo.js';
import { runDoc } from './tools-doc.js';
import { runVerify } from './tools-verify.js';
import { runUsage } from './tools-usage.js';

const KEY_PATTERN = /sk-[a-zA-Z0-9]{16,}/;
const lookupAll = promisify(lookup); // dns.lookup 是回调 API，须 promisify（{all:true} 时返回 [{address,family}]）

/** IP 是否私网/回环/保留段（v4 全段 + v6 常见段）；非法格式一律视为私网拒绝 */
function isPrivateIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    const n = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
    const inCidr = (base, bits) => (((n & (bits === 0 ? 0 : ((~0 << (32 - bits)) >>> 0))) >>> 0) === (base >>> 0)); // & 产出 int32 有符号，须再 >>>0 复原无符号
    return inCidr(0x00000000, 8) || inCidr(0x0A000000, 8) || inCidr(0x64400000, 10) || inCidr(0x7F000000, 8)
      || inCidr(0xA9FE0000, 16) || inCidr(0xAC100000, 12) || inCidr(0xC0A80000, 16) || inCidr(0xC6120000, 15)
      || inCidr(0xE0000000, 4) || inCidr(0xF0000000, 4);
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
    if (s.startsWith('::ffff:')) { // v4 映射地址：递归校验内层
      const inner = s.slice(7);
      return isIP(inner) === 4 ? isPrivateIp(inner) : true;
    }
    return false;
  }
  return true;
}

/** SSRF 域名防线：解析全部 A/AAAA 记录逐个校验（拦数字 IP/十六进制/DNS 重绑定/映射地址） */
async function assertPublicHost(hostname) {
  let ips;
  try { ips = await lookupAll(hostname, { all: true }); } catch { throw new Error(`域名解析失败：${hostname}`); }
  for (const { address } of ips) {
    if (isPrivateIp(address)) throw new Error(`R5: 域名 ${hostname} 解析到私网/保留地址 ${address}，禁止访问`);
  }
}

/** 校验型 lookup（TOCTOU 消除）：net/tls 建连时解析 → 校验 → 把同一结果交给连接使用。
 *  校验（assertPublicHost）与连接（本函数）各自解析的传统方案存在重绑定窗口：两次解析之间 DNS 可换 IP。
 *  这里连接直接消费校验过的地址，攻击窗口归零。注意 net 会以 {all:true} 调用并要求数组形式回调。 */
function guardLookup(hostname, options, callback) {
  const wantAll = !!(options && options.all);
  lookupAll(hostname, { ...options, all: true }, (err, ips) => {
    if (err) return callback(err);
    const safe = [];
    for (const { address, family } of Array.isArray(ips) ? ips : []) {
      if (isPrivateIp(address)) {
        const e = new Error(`R5: 域名 ${hostname} 解析到私网/保留地址 ${address}，禁止访问`);
        e.code = 'ERR_SSRF_BLOCKED';
        return callback(e);
      }
      safe.push({ address, family });
    }
    if (!safe.length) return callback(new Error(`域名无可用解析记录：${hostname}`));
    if (wantAll) return callback(null, safe); // net {all:true} 形式：返回过滤后的完整数组
    const { address, family } = safe[0]; // 传统三参形式
    return callback(null, address, family);
  });
}

/** node:http(s) GET（手动重定向控制 + 同源 IP 校验 + 流式 64KB 截断）
 *  超时三层：socket idle（timeoutMs）+ 硬性总熔断（防 DNS 解析挂起不受 socket 计时）+ per-host 熔断（不可达站点快速失败） */
const hostFail = new Map(); // host → { n, until } 网络层失败计数与冷却截止
function noteHostResult(hostname, ok) {
  const now = Date.now();
  const rec = hostFail.get(hostname) ?? { n: 0, until: 0 };
  if (ok) { if (rec.n) hostFail.delete(hostname); return; }
  rec.n += 1;
  if (rec.n >= 2) rec.until = now + 60_000; // 60s 内 ≥2 次网络层失败 → 熔断 1 分钟
  hostFail.set(hostname, rec);
}
function hostBlocked(hostname) {
  const rec = hostFail.get(hostname);
  return rec && rec.until > Date.now();
}

function rawGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (hostBlocked(u.hostname)) {
      return reject(new Error(`站点近期不可达已熔断（${u.hostname}，60 秒内不再重试，可稍后再试）`));
    }
    const fn = u.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    // 硬性总熔断：DNS 解析挂起/TCP 连接僵死不受 socket idle 计时，必须整体兜底
    const kill = setTimeout(() => {
      if (settled) return; settled = true;
      noteHostResult(u.hostname, false);
      req.destroy(new Error(`请求总超时（${timeoutMs + 2000}ms，含 DNS/连接阶段）`));
      reject(new Error(`请求总超时（${timeoutMs + 2000}ms，含 DNS/连接阶段）`));
    }, timeoutMs + 2000);
    const req = fn(url, {
      lookup: guardLookup,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; evo-agent/1.0)',
        Accept: 'text/html,application/json,text/plain,*/*',
        'Accept-Encoding': 'identity', // 免 gzip 解压（零依赖约束）
      },
    }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 400) noteHostResult(u.hostname, true);
      const chunks = [];
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (c) => {
        size += c.length;
        if (size <= 65_536) chunks.push(c);
        else res.destroy(); // 超限即断流（已收集足够内容）
      });
      res.on('end', () => { if (!settled) { settled = true; clearTimeout(kill); resolve({ status: res.statusCode, headers: res.headers, text: chunks.join('') }); } });
      res.on('error', () => { if (!settled) { settled = true; clearTimeout(kill); resolve({ status: res.statusCode, headers: res.headers, text: chunks.join('') }); } }); // 截断断流按已收内容处理
    });
    req.on('timeout', () => { if (!settled) { settled = true; clearTimeout(kill); noteHostResult(u.hostname, false); req.destroy(new Error(`请求超时（${timeoutMs}ms）`)); } });
    req.on('error', (e) => {
      clearTimeout(kill);
      if (settled) return; settled = true;
      // 网络层错误（DNS/连接层）计入 per-host 熔断；HTTP 4xx/5xx 是服务端响应不算
      if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(String(e?.code ?? e?.message))) noteHostResult(u.hostname, false);
      reject(e);
    });
    req.end();
  });
}

/** 路径囚禁：解析后必须落在 sandbox 根内（防 ../ 与绝对路径逃逸） */
function confine(p, root) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: `路径越出沙箱根：${p}` };
  }
  // Windows 绝对路径（如 C:/Windows/evil.txt）在 Linux 运行时也会绕过检查
  if (/^[A-Za-z]:[\\\/]/.test(p) || /^[A-Za-z]:\/[^/]/.test(p)) {
    return { ok: false, reason: `路径越出沙箱根：${p}` };
  }
  return { ok: true, abs };
}

/** 导出供单元测试（tests/unit/ssrf.test.js） */
export { isPrivateIp, assertPublicHost, guardLookup };

export class ToolRuntime {
  /** LLM 常见幻觉工具名 → 真实注册名的模糊映射（规划器宽容层） */
  static ALIASES = {
    search: 'news_search', web_search: 'news_search', news: 'news_search',
    search_news: 'news_search', google_search: 'news_search', news_query: 'news_search',
    read_file: 'fs_read', read: 'fs_read', file_read: 'fs_read', cat: 'fs_read',
    write_file: 'fs_write', write: 'fs_write', file_write: 'fs_write', save_file: 'fs_write',
    edit_file: 'edit_file', edit: 'edit_file',
    list: 'fs_list', list_files: 'fs_list', list_dir: 'fs_list', dir: 'fs_list',
    get: 'http_get', fetch: 'http_get', curl: 'http_get', http: 'http_get', get_url: 'http_get',
    weather: 'skill:get_weather',
  };

  /** 参数名归一化（吸收 LLM 参数名漂移） */
  static normalizeParams(toolName, p = {}) {
    const q = p.query ?? p.topic ?? p.search ?? p.q ?? p.keyword ?? p.question;
    switch (toolName) {
      case 'news_search':
        return { ...p, query: q, maxResults: p.maxResults ?? p.limit ?? p.num ?? p.count ?? 5 };
      case 'fs_read':
        return { ...p, path: p.path ?? p.file ?? p.filename ?? p.name };
      case 'fs_write':
        return { ...p, path: p.path ?? p.file ?? p.filename, content: p.content ?? p.text ?? p.data };
      case 'edit_file':
        return { ...p, path: p.path ?? p.file ?? p.filename, old_string: p.old_string ?? p.old ?? p.find ?? p.search, new_string: p.new_string ?? p.new ?? p.replace ?? p.with };
      case 'fs_list':
        return { ...p, dir: p.dir ?? p.path ?? p.directory ?? '.' };
      case 'http_get':
        return { ...p, url: p.url ?? p.link ?? p.address };
      default:
        return p;
    }
  }

  /** 名称解析：精确命中 → 别名映射 → undefined */
  resolve(name) {
    if (this.tools.has(name)) return name;
    const mapped = ToolRuntime.ALIASES[name];
    return mapped && (this.tools.has(mapped) || mapped.startsWith('skill:')) ? mapped : undefined;
  }

  constructor(store = null, { workspace = CONFIG.TOOL_WORKSPACE } = {}) {
    this.workspace = workspace;
    this.store = store;
    mkdirSync(workspace, { recursive: true });
    this.tools = new Map();
    this.registerBuiltins();
  }

  get(name) { return this.tools.get(name); }
  list() {
    return [...this.tools.values()].map((t) => ({ name: t.name, desc: t.desc, risk: t.risk }));
  }

  register(tool) { this.tools.set(tool.name, tool); }

  registerBuiltins() {
    // ── create_skill：用户技能创建工具（同步注册，确保 planner prompt 能立即看到）──
    try {
      this.register({
        name: 'create_skill',
        desc: '创建新技能（写入技能库，状态为 DRAFT）',
        risk: 'low',
        checkPermissions: () => ({ ok: true }),
        run: async (p) => {
          const r = await createSkill(p, { store: this.store });
          return r.output;
        },
      });
    } catch (e) {
      console.warn('[tool-runtime] 加载 create_skill 失败:', e.message);
    }
    // ── 低危：读 ──
    this.register({
      name: 'fs_list', desc: '列出沙箱工作区内目录', risk: 'low', requiredParams: [],
      checkPermissions: (p) => (p.dir == null ? { ok: true } : confine(p.dir, this.workspace)),
      run: async (p) => {
        const c = p.dir ? confine(p.dir, this.workspace) : { ok: true, abs: this.workspace };
        if (!c.ok) throw new Error(c.reason);
        return readdirSync(c.abs).slice(0, 200).join(', ') || '(空目录)';
      },
    });
    this.register({
      name: 'fs_read', desc: '读取沙箱工作区内文本文件（≤64KB）', risk: 'low', requiredParams: ['path'],
      checkPermissions: (p) => confine(p.path, this.workspace),
      run: async (p) => {
        const c = confine(p.path, this.workspace);
        if (!c.ok) throw new Error(c.reason);
        if (!existsSync(c.abs)) throw new Error(`文件不存在：${p.path}`);
        const st = statSync(c.abs);
        if (st.size > 65_536) throw new Error('文件过大（>64KB，沙箱限制）');
        if (KEY_PATTERN.test(readFileSync(c.abs, 'utf8').slice(0, 4096))) {
          throw new Error('R4: 文件内容疑似包含凭据，禁止读取外传');
        }
        return readFileSync(c.abs, 'utf8');
      },
    });
    // ── 高危：写（需技能步骤声明 use_reason）──
    this.register({
      name: 'fs_write', desc: '写沙箱工作区内文件', risk: 'high', requiredParams: ['path', 'content'],
      checkPermissions: (p) => {
        const c = confine(p.path, this.workspace);
        if (!c.ok) return c;
        if (typeof p.content !== 'string') return { ok: false, reason: 'content 必填' };
        if (KEY_PATTERN.test(p.content)) return { ok: false, reason: 'R4: 禁止将凭据写入文件' };
        if (!p.use_reason || String(p.use_reason).trim().length < 4) {
          return { ok: false, reason: '高危工具须携带使用理由（use_reason）' };
        }
        return { ok: true };
      },
      run: async (p) => {
        const c = confine(p.path, this.workspace);
        if (!c.ok) throw new Error(c.reason);
        mkdirSync(dirname(c.abs), { recursive: true });
        writeFileSync(c.abs, p.content, 'utf8');
        return `已写入 ${p.path}（${p.content.length} 字符）`;
      },
    });
    // ── 高危：编辑（字符串替换，需 use_reason）──
    this.register({
      name: 'edit_file', desc: '编辑沙箱工作区内文件（通过字符串替换；参数：path, old_string, new_string, 可选 occurrences=1）', risk: 'high', requiredParams: ['path', 'old_string', 'new_string'],
      checkPermissions: (p) => {
        const c = confine(p.path, this.workspace);
        if (!c.ok) return c;
        if (!p.old_string) return { ok: false, reason: 'old_string 必填' };
        if (p.new_string == null) return { ok: false, reason: 'new_string 必填' };
        if (!p.use_reason || String(p.use_reason).trim().length < 4) {
          return { ok: false, reason: '高危工具须携带使用理由（use_reason）' };
        }
        return { ok: true };
      },
      run: async (p) => {
        const c = confine(p.path, this.workspace);
        if (!c.ok) throw new Error(c.reason);
        if (!existsSync(c.abs)) throw new Error(`文件不存在：${p.path}`);
        const content = readFileSync(c.abs, 'utf8');
        const oldStr = String(p.old_string);
        const newStr = String(p.new_string);
        const occurrences = typeof p.occurrences === 'number' ? p.occurrences : 1;
        if (!content.includes(oldStr)) {
          throw new Error(`old_string 未在文件中找到：${oldStr.slice(0, 100)}`);
        }
        if (KEY_PATTERN.test(newStr)) throw new Error('R4: 禁止在文件中写入凭据');
        let result, count = 0;
        if (occurrences === -1 || occurrences === Infinity) {
          result = content.split(oldStr).join(newStr);
          count = (content.split(oldStr).length - 1);
        } else {
          // 只替换前 occurrences 次（remaining 滚动切片，不可重赋 const content）
          let remaining = content;
          let pos = 0;
          let replaced = 0;
          const parts = [];
          while (replaced < occurrences && (pos = remaining.indexOf(oldStr, pos)) !== -1) {
            parts.push(remaining.slice(0, pos));
            parts.push(newStr);
            remaining = remaining.slice(pos + oldStr.length);
            pos = 0;
            replaced++;
          }
          parts.push(remaining);
          result = parts.join('');
          count = replaced;
        }
        writeFileSync(c.abs, result, 'utf8');
        return `已编辑 ${p.path}（替换 ${count} 处）`;
      },
    });
    // ── 高危：网络（域名白名单，R5）──
    this.register({
      name: 'http_get', desc: 'GET 白名单域名 URL', risk: 'high', requiredParams: ['url'],
      checkPermissions: (p) => {
        // 容错：LLM 常给中文未编码 URL（如 bing.com/search?q=AI新闻）——自动 encodeURI 再校验
        if (p.url && /[^\x00-\x7F]/.test(p.url)) p.url = encodeURI(p.url);
        let u;
        try { u = new URL(p.url); } catch { return { ok: false, reason: '非法 URL（http_get 仅用于确切知道完整地址的公开 API；搜索请用 news_search）' }; }
        const host = u.hostname;
        // 私网/回环拦截（防 SSRF 打内网，开放模式下仍保留）
        if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/.test(host) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
          return { ok: false, reason: `R5: 禁止访问私网地址 ${host}` };
        }
        // 开放模式：任意公网域名放行；否则走白名单
        if (!CONFIG.TOOL_NET_OPEN) {
          const allowed = (CONFIG.TOOL_NET_WHITELIST ?? []).some((w) => host === w || host.endsWith('.' + w));
          if (!allowed) return { ok: false, reason: `R5: 域名 ${host} 不在白名单` };
        }
        if (KEY_PATTERN.test(String(p.url))) return { ok: false, reason: 'R4: URL 携带凭据模式' };
        return { ok: true };
      },
      run: async (p) => {
        // 逐跳抓取（TOCTOU 消除版）：node:http + guardLookup —— DNS 校验与建连消费同一次解析结果；
        // 公网 302 跳私网在每一跳都会被 guardLookup 拦截
        let url = String(p.url), res = null;
        for (let hop = 0; hop <= 3; hop++) {
          const u = new URL(url);
          await assertPublicHost(u.hostname); // 快速失败层：解析后立即校验，给出清晰错误（真正防线在 guardLookup）
          try {
            res = await rawGet(url, CONFIG.TOOL_TIMEOUT_MS);
          } catch (e) {
            if (e?.code === 'ERR_SSRF_BLOCKED') throw new Error(e.message);
            throw new Error(`请求失败：${String(e?.message ?? e).slice(0, 120)}`);
          }
          if ([301, 302, 303, 307, 308].includes(res.status)) {
            const loc = res.headers.location;
            if (!loc || hop === 3) throw new Error('重定向次数超限（>3）或缺少 Location');
            url = new URL(loc, url).href;
            continue;
          }
          break;
        }
        try {
          let text = res.text.slice(0, 65_536);
          const ct = String(res.headers['content-type'] ?? '');
          if (ct.includes('html')) {
            // HTML 粗提取：title + meta 描述 + 正文文本（去脚本样式标签）
            const title = text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? '';
            const metaDesc = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1]
              ?? text.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)?.[1] ?? '';
            const body = (text.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? text)
              .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/\s+/g, ' ').trim();
            text = [title && `标题：${title}`, metaDesc && `描述：${metaDesc.trim()}`, `正文：${body}`].filter(Boolean).join('\n');
          }
          return `HTTP ${res.status}: ${text.slice(0, 4096)}`;
        } catch (e) { throw new Error(`响应读取失败：${String(e?.message ?? e).slice(0, 120)}`); }
      },
    });
    // ── 文件列表别名：ls = fs_list（兼容常见用法）──
    this.register({
      name: 'ls', desc: '列出目录（fs_list 的别名）', risk: 'low',
      checkPermissions: (p) => ({ ok: true }),
      run: async (p) => {
        // 调用 fs_list 逻辑
        const fs_list = this.tools.get('fs_list');
        if (!fs_list) throw new Error('fs_list 工具不存在');
        return fs_list.run({ dir: p.dir || '.' });
      },
    });
    // ── 新闻搜索：AnySearch API（免费层 + API Key 可选）──
    this.register({
      name: 'news_search', desc: '搜索新闻/实时信息/时事热点（参数：query 关键词, maxResults 条数）——一切需要最新信息的任务首选此工具', risk: 'medium', requiredParams: ['query'],      checkPermissions: (p) => {
        const hasQuery = p.query || p.topic || p.search || p.q || p.keyword;
        if (!hasQuery) return { ok: false, reason: 'query/topic/keyword 必填' };
        return { ok: true };
      },
      run: async (p) => {
        const query = p.query || p.topic || p.search || p.q || p.keyword || '热点新闻';
        const limit = p.maxResults || p.limit || 10;
        const domain = p.domain || 'general';
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15_000);
        try {
          // 尝试 AnySearch API（支持匿名和 API Key）
          const apiKey = CONFIG.ANYSEARCH_API_KEY || '';
          const apiUrl = 'https://api.anysearch.com/v1/search';
          const body = {
            query: query,
            max_results: Math.min(limit, 10),
            tag: domain === 'general' ? undefined : domain,
          };
          const headers = {
            'Content-Type': 'application/json',
            'X-Anysearch-Client': 'agent/1.0',
          };
          if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }
          const res = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: ac.signal,
          });
          if (res.ok) {
            const data = await res.json();
            if (data.data?.results && data.data.results.length > 0) {
              return data.data.results.map((r, i) => 
                `${i + 1}. ${r.title || '(无标题)'}\n   来源：${r.source || '网络'}\n   链接：${r.url || ''}\n   摘要：${(r.content || r.snippet || '').slice(0, 150)}`
              ).join('\n\n');
            }
          }
          // 降级：Google News RSS
          const encodedQuery = encodeURIComponent(query);
          const rssUrl = `https://news.google.com/rss/search?q=${encodedQuery}&hl=zh-CN&gl=CN&ceid=CN:zh`;
          const rssRes = await fetch(rssUrl, {
            signal: ac.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          if (!rssRes.ok) throw new Error(`HTTP ${rssRes.status}`);
          const text = await rssRes.text();
          const items = [];
          const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
          let match;
          while ((match = itemRegex.exec(text)) && items.length < limit) {
            const item = match[1];
            const titleMatch = item.match(/<title>([^<]+)<\/title>/);
            const linkMatch = item.match(/<link>([^<]+)<\/link>/);
            const sourceMatch = item.match(/<source[^>]*>([^<]+)<\/source>/);
            if (titleMatch) {
              items.push({
                title: titleMatch[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
                link: linkMatch?.[1] || '',
                source: sourceMatch?.[1] || 'Google News'
              });
            }
          }
          if (items.length > 0) {
            return items.map((item, i) => `${i + 1}. ${item.title}\n   来源：${item.source}\n   链接：${item.link}`).join('\n\n');
          }
          return `未找到关于「${query}」的新闻`;
        } catch (e) {
          throw new Error(`新闻搜索失败：${e.message}`);
        } finally { clearTimeout(timer); }
      },
    });
    // ── 并行子调研代理（D2）：多子课题并行"搜索→综合"，只回传结论（过程不进主上下文） ──
    this.register({
      name: 'subagent', desc: '并行子调研（参数：topics 子课题数组或顿号/逗号分隔，≤3 个）：各自搜索并综合，返回各课题结论——适合"分别调研 A、B、C"类任务', risk: 'medium', requiredParams: ['topics'],
      checkPermissions: () => (this.subagentRunner ? { ok: true } : { ok: false, reason: '子调研代理未注入（executor 初始化后可用）' }),
      run: async (p) => this.subagentRunner(p),
    });
    // ── diff：文本/文件差异对比（零 token）──
    this.register({
      name: 'diff', desc: '文件或输入文本差异对比，输出 unified diff（- + 前缀），返回 hasDiff/addedLines/deletedLines/内容', risk: 'low', requiredParams: [],
      run: (p) => runDiff(p),
    });
    // ── probe：HTTP 冒烟探测（零 token）──
    this.register({
      name: 'probe', desc: 'HTTP 端点冒烟验证：检查状态码/响应包含/标题/h1，支持超时（默认15s）', risk: 'low', requiredParams: ['url'],
      run: (p) => runProbe(p),
    });
    // ── query：结构化数据查询（JSON 路径/CSV 筛选）──
    this.register({
      name: 'query', desc: '结构化数据提取：JSON 点路径（$a.b[0]）或 CSV-like 条件筛选（where=col==val）', risk: 'low', requiredParams: ['source'],
      run: (p) => runQuery(p),
    });
    // ── stat：文件/目录客观统计（零 token）──
    this.register({
      name: 'stat', desc: '文件或目录统计：字节/字符/CJK字符数/行数/修改时间；支持 glob 批量', risk: 'low', requiredParams: ['path'],
      run: (p) => runStat(p),
    });
    // ── todo：跨轮任务清单（存 workspace/.todo.json）──
    this.register({
      name: 'todo', desc: '任务清单管理（add/list/toggle/clear/delete），持久化到 workspace/.todo.json，供跨轮跟踪', risk: 'low', requiredParams: ['action'],
      run: (p) => runTodo(p, this.workspace),
    });
    // ── doc：文档提取（txt/md/json/html/csv/log/pdf/docx/xlsx）──
    this.register({
      name: 'doc', desc: '本地文档提取为纯文本：支持 txt/md/json/html/csv/tsv/log/pdf(doc)/docx/xlsx（零依赖，纯 JS 解析）', risk: 'low', requiredParams: ['path'],
      run: (p) => runDoc(p),
    });
    // ── verify：多规则断言器（零 token，一次性检查多条规则）──
    this.register({
      name: 'verify', desc: '批量断言器：rules=[{type:contains, value:"..."}, {type:regex, value:"..."}]，支持 exists/contains/regex/json_valid/min_length/max_length/eq/not_contains/file_exists/line_count，返回 passAll+详情', risk: 'low', requiredParams: ['rules'],
      run: (p) => runVerify(p, this.workspace),
    });
    // ── usage：用量查询（get/history/budget）──
    this.register({
      name: 'usage', desc: '用量查询：get（当前日用量）/history（近N天记录）/budget（预算状态），零 token', risk: 'low', requiredParams: [],
      run: (p) => runUsage(p),
    });
    // ── 特高危：命令行（默认总开关关闭）──
    this.register({
      name: 'shell', desc: '受限子进程执行（默认禁用）', risk: 'critical',
      checkPermissions: (p) => {
        if (!CONFIG.TOOL_SHELL_ENABLED) return { ok: false, reason: 'R2: shell 工具默认禁用（TOOL_SHELL_ENABLED=0）' };
        if (!p.use_reason || String(p.use_reason).length < 8) return { ok: false, reason: '须携带详细使用理由' };
        if (/rm\s+-rf|del\s+\/[sqq]|format\s+[a-z]:|mkfs/i.test(String(p.cmd))) {
          return { ok: false, reason: 'R2: 破坏性命令模式' };
        }
        return { ok: true };
      },
      run: (p) => new Promise((resolve2, reject) => {
        const child = spawn(String(p.cmd), { shell: true, cwd: this.workspace, timeout: CONFIG.TOOL_TIMEOUT_MS, windowsHide: true });
        let out = '';
        child.stdout?.on('data', (d) => (out += d.toString().slice(0, 4096)));
        child.stderr?.on('data', (d) => (out += d.toString().slice(0, 2048)));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve2(out.slice(0, 4096) || '(无输出)') : reject(new Error(`exit ${code}: ${out.slice(0, 300)}`))));
      }),
    });
  }

  /** 统一执行入口：别名解析 → 权限检查（参数归一化后）→ 执行 → 记录调用证据（成败/耗时，喂技能评分）
   *  三重防护（吸收 dual-agent 插件运行时）：① 必填参数执行前校验（缺参返回可重试错误，LLM 看到 schema 自纠）
   *  ② 执行超时兜底（防业务工具挂起卡死任务，SPA_TOOL_TIMEOUT_MS 可调）③ 输出截断 8k（防超长结果撑爆上下文） */
  static TIMEOUT_MS = Number(process.env.SPA_TOOL_TIMEOUT_MS ?? 60_000);
  static OUTPUT_CAP = 8192;

  _checkRequired(tool, params) {
    const req = Array.isArray(tool?.requiredParams) ? tool.requiredParams : [];
    const missing = req.filter((k) => params[k] === undefined || params[k] === null || (typeof params[k] === 'string' && !params[k].trim()));
    if (!missing.length) return '';
    return `工具 ${tool.name} 调用缺少必填参数：${missing.join('、')}。请按工具参数说明重新调用并提供完整参数；若确认上轮已提供，说明参数在传输中丢失，请重试。`;
  }

  async call(name, params, { taskId } = {}) {
    const resolved = this.resolve(name);
    if (!resolved) {
      const known = this.list().map((t) => t.name).join(', ');
      const err = new Error(`未注册工具 ${name}（可用：${known}）`);
      err.unknownTool = true;
      throw err;
    }
    const tool = this.tools.get(resolved) ?? { name: resolved, desc: '技能调用', risk: 'medium', checkPermissions: () => ({ ok: true }) };
    const norm = ToolRuntime.normalizeParams(resolved, params ?? {});
    const missErr = this._checkRequired(tool, norm);
    if (missErr) {
      const err = new Error(missErr);
      err.blocked = true;
      throw err;
    }
    const perm = tool.checkPermissions?.(norm) ?? { ok: true };
    if (!perm.ok) {
      const err = new Error(perm.reason);
      err.blocked = true;
      throw err;
    }
    const start = Date.now();
    try {
      // 锻造区热重载：mtime 变更的工具先重新注册（失败保留旧版本继续执行）
      if (this._forgeReloader) {
        try { await this._forgeReloader(this, resolved); } catch { /* 重载失败不阻塞执行 */ }
      }
      const runP = resolved.startsWith('skill:')
        ? this._runSkillTool(resolved, norm)
        : Promise.resolve(tool.run(norm));
      let timer = null;
      // 超时兜底：业务工具挂起不再卡死任务（内建工具自身有更细粒度超时，此处为外层保险）
      const timeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`工具 ${resolved} 执行超时（${Math.round(ToolRuntime.TIMEOUT_MS / 1000)}s 兜底熔断）`);
          e.timeout = true;
          reject(e);
        }, ToolRuntime.TIMEOUT_MS);
      });
      let output;
      try {
        output = await Promise.race([runP, timeoutP]);
      } finally {
        clearTimeout(timer);
      }
      const s = String(output ?? '');
      return { ok: true, output: s.length > ToolRuntime.OUTPUT_CAP ? s.slice(0, ToolRuntime.OUTPUT_CAP) + '\n…（输出过长已截断）' : s, durationMs: Date.now() - start };
    } catch (e) {
      e.durationMs = Date.now() - start;
      throw e;
    }
  }

  /** skill:<name> 委托执行（经由 skillSystem.executor，避免循环依赖） */
  async _runSkillTool(resolved, params) {
    if (!this.skillSystem?.executor) throw new Error('技能系统未注入');
    const skillName = resolved.slice('skill:'.length);
    return this.skillSystem.executor.executeSkillStep(skillName, params, 'skill-tool');
  }

  /** 锻造区工具热重载钩子（由 dynamic-tool-loader 注入；call 前检查 mtime 变更） */
  setForgeReloader(fn) { this._forgeReloader = fn; }

  /** 工具锻造管理（web API / executor 调用；由 dynamic-tool-loader 实现） */
  setForgeApi(api) { this.forge = api; }

  /** 并行子调研代理（D2）：由 agent-executor 注入 runSubagents 绑定 */
  setSubagentRunner(fn) { this.subagentRunner = fn; }

  /** todo 工作区：由 agent-executor 注入 */
  setTodoWorkspace(ws) { this.todoWorkspace = ws; }
}
