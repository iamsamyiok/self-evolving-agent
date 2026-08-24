// web.js —— ChatGPT 式 Web 界面入口：对话即任务，每轮自动进化，后台持续净化
// 端口默认 3789（SPA_WEB_PORT 可改）；同时挂观测面板（3790，SPA_DASHBOARD_PORT）
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
      // ── 能力分享（社会化进化）：导出/导入技能+记忆+经验 ──
      if (req.method === 'GET' && path === '/api/share/export') {
        const types = (url.searchParams.get('types') ?? 'skill,memory,experience').split(',');
        const pack = { format: 'evo-agent-share', version: 1, exportedAt: Date.now(), items: [] };
        const TABLES = { skill: 'skills', memory: 'memories', experience: 'experiences' };
        for (const ty of types) {
          if (!TABLES[ty]) continue;
          const rows = this.store.db.prepare(`SELECT * FROM ${TABLES[ty]} WHERE state = 'ACTIVE'`).all();
          for (const r of rows) {
            pack.items.push({
              type: ty,
              name: r.name ?? null, scenario: r.scenario ?? null, description: r.description ?? null,
              content: r.content ?? null, summary: r.summary ?? null, rules: r.rules ?? null,
              steps: r.steps ?? null, kind: r.kind ?? null, importance: r.importance ?? null,
              quality_score: r.quality_score,
            });
          }
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="evo-agent-share-${Date.now()}.json"`,
        });
        return res.end(JSON.stringify(pack, null, 2));
      }
      if (req.method === 'POST' && path === '/api/share/import') {
        const b = await body();
        return send(200, this.importShare(b));
      }
      if (req.method === 'POST' && path === '/api/chat') return this.handleChat(req, res, await body());
      // 任务结果查询（断线重连恢复：任务结束落库后可凭 taskId 取回，未结束返回 pending）
      const taskMatch = path.match(/^\/api\/task\/([\w-]+)$/);
      if (taskMatch && req.method === 'GET') {
        const row = this.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskMatch[1]);
        if (!row) return send(200, { status: 'pending' }); // 还在执行（结束才落库）
        const msg = this.store.db.prepare('SELECT meta FROM messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(row.id);
        return send(200, {
          status: row.outcome ? 'done' : 'pending',
          outcome: row.outcome, basis: row.outcome_basis, answer: row.answer, error: row.error,
          durationMs: row.duration_ms, meta: msg?.meta ? JSON.parse(msg.meta) : null,
        });
      }
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
      const taskId = uuid7();
      send({ type: 'stage', stage: 'start', quick, taskId });
      const trace = await this.loop.submitTask(input, {
        quick,
        silent: true,
        taskId,
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

  /** 能力包导入（社会化进化）：格式校验 → 逐条去重 → origin=imported 入库。技能以 DRAFT 入（须过本地黄金门禁，防外部劣质技能直接生效） */
  importShare(pack) {
    if (pack?.format !== 'evo-agent-share' || !Array.isArray(pack.items)) {
      return { ok: false, error: '无效能力包（须由「导出能力」生成的 JSON）' };
    }
    if (pack.items.length > 200) return { ok: false, error: '单次导入上限 200 条' };
    const stat = { imported: 0, skipped: 0, rejected: 0, byType: {} };
    const now = Date.now();
    const imm = now + 24 * 3600_000;
    for (const it of pack.items.slice(0, 200)) {
      try {
        if (it.type === 'skill') {
          if (!it.name || !it.steps) { stat.rejected++; continue; }
          const dup = this.store.db.prepare("SELECT id FROM skills WHERE name = ? AND state IN ('ACTIVE','DRAFT')").get(it.name);
          if (dup) { stat.skipped++; continue; }
          this.store.db.prepare(
            `INSERT INTO skills (id, state, version, parent_id, origin, created_at, updated_at, immunity_until, execution_count, quality_score, embedding, quarantined_at, purge_after, last_used_at, name, scenario, description, steps, params_schema, success_count, fail_count, verified, heat)
             VALUES (?, 'DRAFT', 1, NULL, 'imported', ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, 0, 0, 0, 'warm')`
          ).run(uuid7(), now, now, imm, Math.min(0.9, Math.max(0.2, Number(it.quality_score) || 0.5)),
            String(it.name).slice(0, 60), String(it.scenario ?? it.description ?? '').slice(0, 200),
            String(it.description ?? '').slice(0, 300), typeof it.steps === 'string' ? it.steps.slice(0, 8000) : JSON.stringify(it.steps).slice(0, 8000));
          stat.imported++; stat.byType.skill = (stat.byType.skill ?? 0) + 1;
        } else if (it.type === 'memory') {
          if (!it.content || String(it.content).trim().length < 4) { stat.rejected++; continue; }
          const exists = this.store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content = ? AND state = 'ACTIVE'").get(String(it.content));
          if (exists.n > 0) { stat.skipped++; continue; }
          this.store.db.prepare(
            `INSERT INTO memories (id, state, version, parent_id, origin, created_at, updated_at, immunity_until, execution_count, quality_score, embedding, quarantined_at, purge_after, last_used_at, tier, kind, content, importance, access_count, expires_at, supersede_of, entities, task_id)
             VALUES (?, 'ACTIVE', 1, NULL, 'imported', ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, 'long', ?, ?, ?, 0, NULL, NULL, NULL, NULL)`
          ).run(uuid7(), now, now, imm, Math.min(0.9, Math.max(0.2, Number(it.quality_score) || 0.5)), now,
            ['semantic', 'episodic', 'procedural'].includes(it.kind) ? it.kind : 'semantic',
            String(it.content).slice(0, 300), Math.min(1, Math.max(0, Number(it.importance) || 0.6)));
          stat.imported++; stat.byType.memory = (stat.byType.memory ?? 0) + 1;
        } else if (it.type === 'experience') {
          if (!it.summary || String(it.summary).trim().length < 4) { stat.rejected++; continue; }
          const exists = this.store.db.prepare("SELECT COUNT(*) AS n FROM experiences WHERE summary = ? AND state = 'ACTIVE'").get(String(it.summary));
          if (exists.n > 0) { stat.skipped++; continue; }
          this.store.db.prepare(
            `INSERT INTO experiences (id, state, version, parent_id, origin, created_at, updated_at, immunity_until, execution_count, quality_score, embedding, quarantined_at, purge_after, last_used_at, task_signature, summary, rules, pitfalls, failure_taxonomy, evidence, sample_count, success_count, fail_count)
             VALUES (?, 'ACTIVE', 1, NULL, 'imported', ?, ?, ?, 0, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`
          ).run(uuid7(), now, now, imm, Math.min(0.9, Math.max(0.2, Number(it.quality_score) || 0.5)), now,
            String(it.summary).slice(0, 120),
            String(it.summary).slice(0, 200), typeof it.rules === 'string' ? it.rules : JSON.stringify(it.rules ?? []),
            JSON.stringify(it.pitfalls ?? []), it.failure_taxonomy ?? null,
            JSON.stringify([{ imported: true, at: now }]));
          stat.imported++; stat.byType.experience = (stat.byType.experience ?? 0) + 1;
        } else { stat.rejected++; }
      } catch { stat.rejected++; }
    }
    return { ok: true, ...stat };
  }
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

  // 同步挂观测面板（只读）
  try {
    const { MonitorView, bindLlm } = await import('./extend/monitor-view.js');
    bindLlm(await import('./core/llm-adapter.js'));
    const dash = new MonitorView({ store, loop, purify, control });
    await dash.listen(CONFIG.DASHBOARD_PORT, (input) => loop.submitTask(input));
    console.log(`[web] 观测面板  http://127.0.0.1:${CONFIG.DASHBOARD_PORT}`);
  } catch (e) { console.warn('[web] 面板启动失败（不影响对话）:', e.message); }

  return { web, store, executor, purify, loop, control };
}

if (process.argv[1] && process.argv[1].endsWith('web.js')) {
  startWeb().catch((e) => { console.error('致命错误:', e); process.exit(1); });
}
