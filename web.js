// web.js —— ChatGPT 式 Web 界面入口：对话即任务，每轮自动进化，后台持续净化
// 端口默认 3789（SPA_WEB_PORT 可改）；同时挂净化面板（3790，SPA_DASHBOARD_PORT）
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config/index.js';
import { Store, uuid7 } from './core/store-base.js';
import { AgentExecutor } from './core/agent-executor.js';
import { PurifyCenter } from './core/purify-center.js';
import { AutoControl, bindStoreClass } from './core/auto-control.js';
import { EvolvePurifyLoop } from './service/evolve-purify-loop.js';
import { setRuntimeConfig, effectiveLLM, pingLLM, getUsage } from './core/llm-adapter.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

function maskKey(k) { return k ? `${k.slice(0, 5)}***${k.slice(-4)}` : ''; }

export class WebServer {
  constructor({ store, executor, loop, control, configPath = join(ROOT, 'config', 'local.json') }) {
    this.store = store;
    this.executor = executor;
    this.loop = loop;
    this.control = control;
    this.configPath = configPath;
    this.server = null;
  }

  // ───────── 会话持久化 ─────────
  newConversation(title = '新对话') {
    const id = uuid7();
    const now = Date.now();
    this.store.db.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title.slice(0, 60), now, now);
    return { id, title, created_at: now, updated_at: now };
  }

  conversations() {
    return this.store.db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n
      FROM conversations c ORDER BY c.updated_at DESC LIMIT 100
    `).all();
  }

  messages(convId) {
    return this.store.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 500').all(convId)
      .map((m) => ({ id: m.id, role: m.role, content: m.content, meta: m.meta ? JSON.parse(m.meta) : null, createdAt: m.created_at }));
  }

  addMessage(convId, role, content, { taskId = null, meta = null } = {}) {
    const id = uuid7();
    const now = Date.now();
    this.store.db.prepare('INSERT INTO messages (id, conversation_id, role, content, task_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, convId, role, content, taskId, meta ? JSON.stringify(meta) : null, now);
    this.store.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
    return id;
  }

  // ───────── 进化状态（前端「正在变好」面板）─────────
  state() {
    const store = this.store;
    const activeStates = "('ACTIVE','DRAFT','COOLING','DEPRECATED','EXPIRED','FROZEN')";
    const entities = {};
    for (const t of ['skill', 'memory', 'experience']) {
      const rows = store.list(t, `WHERE state IN ${activeStates}`);
      entities[t] = {
        count: rows.length,
        avgQ: rows.length ? Number((rows.reduce((a, r) => a + r.quality_score, 0) / rows.length).toFixed(3)) : null,
      };
    }
    const tasks = store.db.prepare('SELECT outcome FROM tasks ORDER BY created_at DESC LIMIT 500').all();
    const last20 = tasks.slice(0, 20).map((t) => (t.outcome === 'SUCCESS' ? 1 : 0));
    const successRate = tasks.length ? tasks.filter((t) => t.outcome === 'SUCCESS').length / tasks.length : null;
    const funnel = store.db.prepare("SELECT action, COUNT(*) AS n FROM purge_logs WHERE status = 'DONE' GROUP BY action").all()
      .reduce((acc, r) => { acc[r.action] = r.n; return acc; }, {});
    const review = store.getState('review_history', { sampled: 0, overturned: 0 });
    const eff = effectiveLLM();
    return {
      llm: {
        configured: Boolean(eff.apiKey) || CONFIG.MOCK,
        mock: CONFIG.MOCK,
        model: eff.model,
        baseUrl: eff.baseUrl,
        keyMasked: maskKey(eff.apiKey),
      },
      entities,
      tasks: { total: tasks.length, successRate: last20.length ? last20.reduce((a, b) => a + b, 0) / last20.length : successRate, allRate: successRate, last20 },
      purify: {
        funnel,
        recent: store.purgeLogs(12).map((l) => ({ at: l.created_at, action: l.action, dimension: l.dimension, entity: l.entity_id.slice(0, 8), reason: l.reason.slice(0, 50) })),
        review: { ...review, overturnRate: review.sampled ? Number((review.overturned / review.sampled).toFixed(3)) : null },
        netRateHistory: store.getState('net_rate_history', []),
        tombstones: store.tombstones().length,
      },
      golden: store.db.prepare('SELECT COUNT(*) AS n FROM golden_tasks WHERE enabled = 1').get().n,
      tuned: store.getState('tuned_retrieval', null),
      usage: (() => { const u = getUsage(); return { in: u.tokensIn, out: u.tokensOut, budget: CONFIG.DAILY_TOKEN_BUDGET }; })(),
    };
  }

  // ───────── 配置读写（热生效）─────────
  getConfig() {
    const eff = effectiveLLM();
    return { baseUrl: eff.baseUrl, model: eff.model, apiKeyMasked: maskKey(eff.apiKey), configured: Boolean(eff.apiKey) || CONFIG.MOCK, mock: CONFIG.MOCK };
  }

  saveConfig({ baseUrl, apiKey, model }) {
    let local = {};
    if (existsSync(this.configPath)) {
      try { local = JSON.parse(readFileSync(this.configPath, 'utf8')); } catch { /* 坏文件重建 */ }
    }
    const next = { ...local };
    if (baseUrl) next.LLM_BASE_URL = baseUrl.replace(/\/+$/, '');
    if (model) next.LLM_MODEL = model;
    if (apiKey) next.LLM_API_KEY = apiKey; // 留空 = 保留原 Key
    writeFileSync(this.configPath, JSON.stringify(next, null, 2));
    setRuntimeConfig({ baseUrl: next.LLM_BASE_URL, model: next.LLM_MODEL, ...(apiKey ? { apiKey } : {}) });
    return this.getConfig();
  }

  // ───────── HTTP ─────────
  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    const body = async () => {
      let b = '';
      for await (const c of req) b += c;
      try { return JSON.parse(b || '{}'); } catch { return {}; }
    };

    try {
      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(readFileSync(join(ROOT, 'web', 'chat.html'), 'utf8'));
        return;
      }
      if (req.method === 'GET' && path === '/api/config') return send(200, this.getConfig());
      if (req.method === 'POST' && path === '/api/config') {
        const b = await body();
        if (!b.baseUrl && !b.model && !b.apiKey) return send(400, { error: '无有效字段' });
        return send(200, this.saveConfig(b));
      }
      if (req.method === 'POST' && path === '/api/config/test') {
        const b = await body();
        const r = await pingLLM(b);
        return send(200, r);
      }
      if (req.method === 'GET' && path === '/api/state') return send(200, this.state());
      if (req.method === 'GET' && path === '/api/conversations') return send(200, this.conversations());
      if (req.method === 'POST' && path === '/api/conversations') {
        const b = await body();
        return send(200, this.newConversation(b.title));
      }
      const convMatch = path.match(/^\/api\/conversations\/([\w-]+)(\/messages)?$/);
      if (convMatch) {
        const id = convMatch[1];
        if (req.method === 'GET' && convMatch[2]) return send(200, this.messages(id));
        if (req.method === 'DELETE') {
          this.store.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
          this.store.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
          return send(200, { ok: true });
        }
      }
      if (req.method === 'POST' && path === '/api/chat') return this.handleChat(req, res, await body());
      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (!res.headersSent) send(500, { error: String(e?.message ?? e) });
      else res.end();
    }
  }

  /** 流式对话：NDJSON 事件流（conversation / stage / done / error） */
  async handleChat(req, res, { conversationId, content, quick = false }) {
    if (!content || !String(content).trim()) {
      res.writeHead(400, { 'Content-Type': 'application/x-ndjson' });
      return res.end(JSON.stringify({ type: 'error', error: '消息为空' }) + '\n');
    }
    content = String(content).slice(0, 8000);
    const eff = effectiveLLM();
    if (!CONFIG.MOCK && !eff.apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/x-ndjson' });
      return res.end(JSON.stringify({ type: 'error', error: '请先配置 LLM（右上角 ⚙️）' }) + '\n');
    }
    // 先落 header，再用 send 写事件，避免 writeHead 第二次调用报错
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
    const send = (obj) => res.write(JSON.stringify(obj) + '\n');

    // 会话：新建则以首句为题
    let conv = conversationId ? this.store.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) : null;
    if (!conv) {
      conv = this.newConversation(content.trim().slice(0, 24));
      send({ type: 'conversation', conversation: conv });
    } else {
      send({ type: 'conversation', conversation: conv });
    }

    // 落库用户消息 + 组装对话上下文（最近 6 条）
    const userMsgId = this.addMessage(conv.id, 'user', content);
    const recent = this.store.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 7').all(conv.id).reverse()
      .filter((m) => m.id !== userMsgId);
    const input = recent.length
      ? `【多轮对话，结合上下文回答当前问题】\n${recent.map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 300)}`).join('\n')}\n\n【当前问题】${content}`
      : content;

    try {
      send({ type: 'stage', stage: 'start', quick });
      const trace = await this.loop.submitTask(input, {
        quick,
        silent: true,
        onProgress: (e) => send({ type: 'stage', ...e }),
      });
      const meta = {
        outcome: trace.outcome,
        basis: trace.basis,
        durationMs: trace.duration_ms,
        quick,
        contextUsed: trace.contextUsed ?? { skills: [], memories: [], experiences: [] },
        taskId: trace.id,
        error: trace.error,
      };
      const msgId = this.addMessage(conv.id, 'assistant', trace.answer ?? `（任务失败：${trace.error ?? '未知错误'}）`, { taskId: trace.id, meta });
      send({ type: 'done', message: { id: msgId, role: 'assistant', content: trace.answer ?? '', meta, createdAt: Date.now() } });
    } catch (e) {
      send({ type: 'error', error: String(e?.message ?? e) });
    }
    res.end();
  }

  listen(port) {
    this.server = createServer((req, res) => this.handle(req, res));
    return new Promise((resolve) => this.server.listen(port, () => resolve(this.server)));
  }
  close() { this.server?.close(); }
}

/** 独立启动入口：node web.js */
export async function startWeb({ port = Number(process.env.SPA_WEB_PORT ?? 3789) } = {}) {
  bindStoreClass(Store);
  const store = new Store();
  const executor = new AgentExecutor(store);
  const purify = new PurifyCenter(store, executor);
  const control = new AutoControl(store);
  const loop = new EvolvePurifyLoop(executor, purify, control);

  executor.onTaskDone = () => { try { control.checkCounterMetrics(); } catch { /* 观测不阻断 */ } };
  loop.onDeepCycle = async () => {
    try {
      await control.tune({ executor });
      await control.strategyPurify({ executor });
    } catch (e) { control.event('post_cycle_error', { error: String(e?.message ?? e) }); }
  };
  loop.onRiskRollback = async (risk) => {
    if (risk?.action === 'rollback_proposed' && CONFIG.AUTO_ROLLBACK) {
      const r = control.rollbackSnapshot(risk.snapshot);
      control.event('auto_rollback', r);
    }
  };

  control.startupCheck();
  loop.start(); // 后台双循环：聊天期间持续净化（轻量 10min±抖动 / 深度每日+启动30s内一轮）

  const web = new WebServer({ store, executor, loop, control });
  await web.listen(port);
  console.log(`[web] 对话界面  http://127.0.0.1:${port}   （ChatGPT 式 · 每轮对话自动进化）`);

  // 同步挂净化面板（观测用，只读）
  try {
    const { MonitorView, bindLlm } = await import('./extend/monitor-view.js');
    bindLlm(await import('./core/llm-adapter.js'));
    const dash = new MonitorView({ store, loop, purify, control });
    await dash.listen(CONFIG.DASHBOARD_PORT, (input) => loop.submitTask(input));
    console.log(`[web] 净化面板  http://127.0.0.1:${CONFIG.DASHBOARD_PORT}`);
  } catch (e) { console.warn('[web] 面板启动失败（不影响对话）:', e.message); }

  return { web, store, executor, purify, loop, control };
}

if (process.argv[1] && process.argv[1].endsWith('web.js')) {
  startWeb().catch((e) => { console.error('致命错误:', e); process.exit(1); });
}
