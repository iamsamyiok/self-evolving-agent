// core/watchdog.js —— 看门狗监督进程（§7.3）：spawn 守护工作进程，心跳 >3min 未更新或退出 → 强制重启
// 反指标护栏：24h 内重启 >3 次 → 停止重启并告警（§12.3）
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export class Watchdog {
  constructor({ dataDir, workerArgs = ['app.js', '--serve'], env = {} } = {}) {
    this.dataDir = dataDir;
    this.workerArgs = workerArgs;
    this.env = env;
    this.child = null;
    this.restartLog = join(dataDir, '..', 'logs', 'watchdog-restarts.json');
    this.stopped = false;
  }

  restartsToday() {
    const today = new Date().toISOString().slice(0, 10);
    let log = { day: today, count: 0, at: [] };
    try { log = JSON.parse(readFileSync(this.restartLog, 'utf8')); } catch { /* 首次 */ }
    if (log.day !== today) log = { day: today, count: 0, at: [] };
    return log;
  }

  recordRestart(reason) {
    const log = this.restartsToday();
    log.count++;
    log.at.push({ at: Date.now(), reason });
    mkdirSync(dirname(this.restartLog), { recursive: true });
    writeFileSync(this.restartLog, JSON.stringify(log, null, 2));
    return log.count;
  }

  heartbeatStale() {
    const p = join(this.dataDir, 'heartbeat.json');
    if (!existsSync(p)) return { stale: true, reason: 'no_heartbeat' };
    try {
      const hb = JSON.parse(readFileSync(p, 'utf8'));
      const age = Date.now() - hb.at;
      return age > 180_000 ? { stale: true, reason: `heartbeat ${Math.round(age / 1000)}s 未更新` } : { stale: false };
    } catch {
      return { stale: true, reason: 'heartbeat 损坏' };
    }
  }

  spawnWorker() {
    this.child = spawn(process.execPath, [join(ROOT, ...this.workerArgs)], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...this.env },
    });
    console.log(`[watchdog] worker 已启动 pid=${this.child.pid}`);
    this.child.on('exit', async (code, signal) => {
      if (this.stopped) return;
      console.log(`[watchdog] worker 退出 code=${code} signal=${signal}`);
      await this.maybeRestart(`worker_exit(${code})`);
    });
  }

  async maybeRestart(reason) {
    if (this.stopped) return;
    const count = this.recordRestart(reason);
    if (count > 3) {
      console.error(`[watchdog] ⛔ 24h 内重启已达 ${count} 次（反指标红线），停止自动重启，需人工介入`);
      this.stopped = true;
      return;
    }
    console.log(`[watchdog] 5s 后重启 worker（今日第 ${count} 次）：${reason}`);
    setTimeout(() => !this.stopped && this.spawnWorker(), 5000);
  }

  start() {
    console.log(`[watchdog] 监督启动（心跳阈值 3min，重启红线 3 次/日）`);
    this.spawnWorker();
    this.monitor = setInterval(async () => {
      if (this.stopped || !this.child) return;
      const hb = this.heartbeatStale();
      if (hb.stale) {
        console.warn(`[watchdog] ⚠️ ${hb.reason}，强制重启 worker`);
        this.child.kill('SIGKILL');
        await this.maybeRestart(hb.reason);
      }
    }, 30_000);
    this.monitor.unref?.();
    const stop = () => {
      this.stopped = true;
      clearInterval(this.monitor);
      this.child?.kill();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}
