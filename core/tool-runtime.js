// core/tool-runtime.js —— 真实工具调用体系（§9.2）+ 沙箱（§8.2）
// 纪律：声明式工具清单（名称/参数/权限级别）；高危工具默认拒绝需理由；文件限定沙箱根；网络域名白名单。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, join, relative, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from '../config/index.js';
import { createSkill } from './skills/create-skill.js';

const KEY_PATTERN = /sk-[a-zA-Z0-9]{16,}/;

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

export class ToolRuntime {
  /** LLM 常见幻觉工具名 → 真实注册名的模糊映射（规划器宽容层） */
  static ALIASES = {
    search: 'news_search', web_search: 'news_search', news: 'news_search',
    search_news: 'news_search', google_search: 'news_search', news_query: 'news_search',
    read_file: 'fs_read', read: 'fs_read', file_read: 'fs_read', cat: 'fs_read',
    write_file: 'fs_write', write: 'fs_write', file_write: 'fs_write', save_file: 'fs_write',
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
      name: 'fs_list', desc: '列出沙箱工作区内目录', risk: 'low',
      checkPermissions: (p) => (p.dir == null ? { ok: true } : confine(p.dir, this.workspace)),
      run: async (p) => {
        const c = p.dir ? confine(p.dir, this.workspace) : { ok: true, abs: this.workspace };
        if (!c.ok) throw new Error(c.reason);
        return readdirSync(c.abs).slice(0, 200).join(', ') || '(空目录)';
      },
    });
    this.register({
      name: 'fs_read', desc: '读取沙箱工作区内文本文件（≤64KB）', risk: 'low',
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
      name: 'fs_write', desc: '写沙箱工作区内文件', risk: 'high',
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
    // ── 高危：网络（域名白名单，R5）──
    this.register({
      name: 'http_get', desc: 'GET 白名单域名 URL', risk: 'high',
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
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), CONFIG.TOOL_TIMEOUT_MS);
        try {
          const res = await fetch(p.url, {
            signal: ac.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; evo-agent/1.0)', Accept: 'text/html,application/json,text/plain,*/*' },
          });
          let text = (await res.text()).slice(0, 65_536);
          const ct = res.headers.get('content-type') ?? '';
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
        } finally { clearTimeout(timer); }
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
      name: 'news_search', desc: '搜索新闻/实时信息/时事热点（参数：query 关键词, maxResults 条数）——一切需要最新信息的任务首选此工具', risk: 'medium',
      checkPermissions: (p) => {
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

  /** 统一执行入口：别名解析 → 权限检查（参数归一化后）→ 执行 → 记录调用证据（成败/耗时，喂技能评分） */
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
    const perm = tool.checkPermissions?.(norm) ?? { ok: true };
    if (!perm.ok) {
      const err = new Error(perm.reason);
      err.blocked = true;
      throw err;
    }
    const start = Date.now();
    try {
      const output = resolved.startsWith('skill:')
        ? await this._runSkillTool(resolved, norm)
        : await tool.run(norm);
      return { ok: true, output, durationMs: Date.now() - start };
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
}
