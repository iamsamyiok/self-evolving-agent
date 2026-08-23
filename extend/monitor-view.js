// extend/monitor-view.js —— 进化/净化可视化面板（§9.4）：零依赖 node:http + 内嵌 HTML（独立文件）+ SSE 事件流
// 纪律：面板只读消费（不参与决策）；POST /api/task 仅为任务提交入口（走正常调度）。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config/index.js';

const DASHBOARD_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html'), 'utf8');

// app.js 启动时注入（避免 monitor-view → llm-adapter 的静态循环）
export function bindLlm(mod) { globalThis.__spa_llm = mod; }

export class MonitorView {
  constructor({ store, loop, purify, control }) {
    this.store = store;
    this.loop = loop;
    this.purify = purify;
    this.control = control;
    this.server = null;
    this.sseClients = new Set();
    this.lastPushedLogAt = 0;
  }

  metrics() {
    const store = this.store;
    const stats = store.stats();
    const qDist = { skill: [], memory: [], experience: [] };
    for (const t of ['skill', 'memory', 'experience']) {
      for (const r of store.list(t, "WHERE state IN ('ACTIVE','DRAFT','COOLING','DEPRECATED','EXPIRED','FROZEN')")) {
        qDist[t].push(Number(r.quality_score.toFixed(2)));
      }
    }
    const purgeFunnel = store.db.prepare(
      "SELECT action, COUNT(*) AS n FROM purge_logs WHERE status = 'DONE' GROUP BY action"
    ).all().reduce((acc, r) => { acc[r.action] = r.n; return acc; }, {});
    const review = store.getState('review_history', { sampled: 0, overturned: 0 });
    const tasks = store.db.prepare("SELECT outcome, COUNT(*) AS n FROM tasks GROUP BY outcome").all();
    const recentPurges = store.purgeLogs(30).map((l) => ({
      at: l.created_at, status: l.status, dimension: l.dimension, action: l.action,
      entity: `${l.entity_type}:${l.entity_id.slice(0, 8)}…`, reason: l.reason,
    }));
    return {
      stats,
      qDist,
      netRateHistory: store.getState('net_rate_history', []),
      taskSuccess: tasks.reduce((acc, t) => { acc[t.outcome] = t.n; return acc; }, {}),
      purgeFunnel,
      review: { ...review, overturnRate: review.sampled ? Number((review.overturned / review.sampled).toFixed(3)) : null },
      golden: stats.golden,
      tombstones: store.tombstones().length,
      usage: this.usageSnapshot(),
      loop: this.loop ? { tasks: this.loop.stats.tasks, purifyCycles: this.loop.stats.purifyCycles, deepCycles: this.loop.stats.deepCycles ?? 0, queueDepth: this.loop.taskQueue?.length ?? 0 } : null,
      recentPurges,
      constitution: store.getState('constitution_sha', {})?.version ?? null,
      tuned: store.getState('tuned_retrieval', null),
      planFailShare: store.getState('plan_fail_share', null),
      prompts: store.prompts().map((p) => ({ role: p.role, version: p.version, status: p.status, sha: p.sha256.slice(0, 8) })),
      tuneLogs: store.tuneLogs(10).map((t) => ({ key: t.key_name, from: t.old_value, to: t.new_value, reason: t.reason, gate: t.golden_gate })),
    };
  }

  usageSnapshot() {
    try {
      const mod = globalThis.__spa_llm;
      const u = mod?.getUsage?.() ?? { tokensIn: 0, tokensOut: 0, calls: 0, errors: 0 };
      return { today: { in: u.tokensIn, out: u.tokensOut, calls: u.calls, errors: u.errors }, budget: CONFIG.DAILY_TOKEN_BUDGET };
    } catch { return null; }
  }

  /** SSE：每 2s 检查 purge_logs 增量并推送（面板事件流，只读） */
  startEventStream() {
    setInterval(() => {
      if (!this.sseClients.size) return;
      const logs = this.store.purgeLogs(5);
      if (!logs.length) return;
      const fresh = this.lastPushedLogAt > 0 ? logs.filter((l) => l.created_at > this.lastPushedLogAt) : [];
      this.lastPushedLogAt = Math.max(this.lastPushedLogAt, logs[0].created_at);
      for (const l of fresh) {
        const data = `event: purge\ndata: ${JSON.stringify({ action: l.action, dimension: l.dimension, entity: l.entity_id.slice(0, 8), reason: l.reason })}\n\n`;
        for (const res of this.sseClients) res.write(data);
      }
    }, 2000).unref?.();
  }

  listen(port = CONFIG.DASHBOARD_PORT, taskSubmit = null) {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.metrics()));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 5000\n\n');
        this.sseClients.add(res);
        req.on('close', () => this.sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/task' && taskSubmit) {
        let body = '';
        for await (const chunk of req) body += chunk;
        try {
          const { input } = JSON.parse(body);
          if (!input) throw new Error('缺少 input');
          const trace = await taskSubmit(input);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ outcome: trace.outcome, answer: trace.answer?.slice(0, 500), error: trace.error }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message) }));
        }
        return;
      }
      res.writeHead(404); res.end('not found');
    });
    return new Promise((resolve) => this.server.listen(port, () => {
      console.log(`[dashboard] http://127.0.0.1:${port}`);
      this.startEventStream();
      resolve(this.server);
    }));
  }

  close() { this.server?.close(); }
}
