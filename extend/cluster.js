// extend/cluster.js —— 多 Agent 集群（§9.3）：协调者 + N 工作进程（stdio JSON 行协议）
// 分工路由：任务按能力画像（技能场景摘要）BM25 匹配路由，无匹配则轮转；
// 共享池：worker 技能晋升 → 提案 → 协调者黄金门禁 → 广播全体（防单点污染全局）；
// 墓碑全局共享（防同一劣质内容在不同节点轮番复活）。
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config/index.js';
import { BM25Index } from '../utils/similarity.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export class ClusterCoordinator {
  constructor({ workers = 2, onLog = console.log } = {}) {
    this.n = workers;
    this.workers = new Map(); // id -> {proc, capabilities: [], busy}
    this.pending = new Map(); // taskId -> {resolve, reject}
    this.sharedPool = [];     // 已验证共享技能
    this.tombstones = [];
    this.rr = 0;
    this.onLog = onLog;
  }

  start() {
    for (let i = 0; i < this.n; i++) this.spawnWorker(i);
    return new Promise((resolve) => setTimeout(() => resolve(this.status()), 1500));
  }

  spawnWorker(i) {
    const proc = spawn(process.execPath, [join(ROOT, 'worker.js')], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, SPA_DATA_DIR: join(CONFIG.DATA_DIR, `worker-${i}`), SPA_WORKER_ID: String(i) },
    });
    const w = { id: i, proc, capabilities: [], busy: false };
    this.workers.set(i, w);
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          this.handleMessage(w, JSON.parse(line));
        } catch { /* 非 JSON 行（日志残留）忽略 */ }
      }
    });
    proc.on('exit', () => {
      if (this.stopped) return;
      this.onLog(`[cluster] worker-${i} 退出，3s 后重启`);
      setTimeout(() => this.spawnWorker(i), 3000);
    });
    this.send(w, { type: 'ping' });
  }

  send(w, msg) { w.proc.stdin.write(JSON.stringify(msg) + '\n'); }

  handleMessage(w, msg) {
    switch (msg.type) {
      case 'pong':
        w.capabilities = msg.capabilities ?? [];
        break;
      case 'result': {
        const p = this.pending.get(msg.taskId);
        if (p) { this.pending.delete(msg.taskId); w.busy = false; p.resolve({ worker: w.id, ...msg.trace }); }
        break;
      }
      case 'propose': {
        // 提案-验证-合并（§9.3-3）：协调者验证后才广播（防单点污染全局）
        this.sharedPool.push({ from: w.id, skill: msg.skill, verified: msg.verified ?? false });
        this.onLog(`[cluster] 收到技能提案「${msg.skill?.name}」verified=${msg.verified}`);
        if (msg.verified) {
          for (const other of this.workers.values()) {
            if (other.id !== w.id) this.send(other, { type: 'broadcast', skill: msg.skill });
          }
        }
        break;
      }
      case 'tombstone': {
        // 墓碑全局共享（§9.3-4）
        if (!this.tombstones.some((t) => t.digest === msg.digest)) this.tombstones.push(msg);
        for (const other of this.workers.values()) {
          if (other.id !== w.id) this.send(other, { type: 'tombstone', digest: msg.digest });
        }
        break;
      }
      default: break;
    }
  }

  /** 能力匹配度路由（技能覆盖 × 负载水位，§9.3-1） */
  route(input) {
    const idle = [...this.workers.values()].filter((w) => !w.busy && w.capabilities.length);
    if (idle.length) {
      const idx = new BM25Index(idle.flatMap((w) => w.capabilities.map((c, j) => ({ id: `${w.id}:${j}`, text: c }))));
      const top = idx.search(input, 1)[0];
      if (top) return this.workers.get(Number(top.id.split(':')[0]));
    }
    const all = [...this.workers.values()];
    return all[this.rr++ % all.length];
  }

  submitTask(input) {
    const w = this.route(input);
    if (!w) return Promise.reject(new Error('无可用 worker'));
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    w.busy = true;
    this.send(w, { type: 'task', taskId, input });
    return new Promise((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(taskId)) {
          this.pending.delete(taskId);
          w.busy = false;
          reject(new Error(`任务 ${taskId} 超时（worker-${w.id}）`));
        }
      }, 120_000).unref?.();
    });
  }

  status() {
    return {
      workers: [...this.workers.values()].map((w) => ({ id: w.id, busy: w.busy, capabilities: w.capabilities.length, pid: w.proc.pid })),
      sharedPool: this.sharedPool.length,
      sharedVerified: this.sharedPool.filter((s) => s.verified).length,
      globalTombstones: this.tombstones.length,
      pending: this.pending.size,
    };
  }

  stop() {
    this.stopped = true;
    for (const w of this.workers.values()) w.proc.kill();
  }
}
