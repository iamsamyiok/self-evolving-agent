// core/tool-runtime.js —— 真实工具调用体系（§9.2）+ 沙箱（§8.2）
// 纪律：声明式工具清单（名称/参数/权限级别）；高危工具默认拒绝需理由；文件限定沙箱根；网络域名白名单。
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, resolve, join, relative, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from '../config/index.js';

const KEY_PATTERN = /sk-[a-zA-Z0-9]{16,}/;

/** 路径囚禁：解析后必须落在 sandbox 根内（防 ../ 与绝对路径逃逸） */
function confine(p, root) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(resolve(root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: `路径越出沙箱根：${p}` };
  }
  return { ok: true, abs };
}

export class ToolRuntime {
  constructor({ workspace = CONFIG.TOOL_WORKSPACE } = {}) {
    this.workspace = workspace;
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
        let u;
        try { u = new URL(p.url); } catch { return { ok: false, reason: '非法 URL' }; }
        const host = u.hostname;
        const allowed = (CONFIG.TOOL_NET_WHITELIST ?? []).some((w) => host === w || host.endsWith('.' + w));
        if (!allowed) return { ok: false, reason: `R5: 域名 ${host} 不在白名单` };
        if (KEY_PATTERN.test(String(p.url))) return { ok: false, reason: 'R4: URL 携带凭据模式' };
        return { ok: true };
      },
      run: async (p) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), CONFIG.TOOL_TIMEOUT_MS);
        try {
          const res = await fetch(p.url, { signal: ac.signal });
          const text = (await res.text()).slice(0, 4096);
          return `HTTP ${res.status}: ${text}`;
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

  /** 统一执行入口：权限检查 → 执行 → 记录调用证据（成败/耗时，喂技能评分） */
  async call(name, params, { taskId } = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未注册工具 ${name}`);
    const perm = tool.checkPermissions?.(params) ?? { ok: true };
    if (!perm.ok) {
      const err = new Error(perm.reason);
      err.blocked = true;
      throw err;
    }
    const start = Date.now();
    try {
      const output = await tool.run(params);
      return { ok: true, output, durationMs: Date.now() - start };
    } catch (e) {
      e.durationMs = Date.now() - start;
      throw e;
    }
  }
}
