// service/evolve-purify-loop.js —— L7/L8 双循环调度（§7）：任务 P0 → 进化 P1 → 净化 P2（吃空闲）
// 互斥：runExclusive(entityId/...)；背压：队列深 → 净化降频；净化定时有 ±20% 抖动。
import { CONFIG } from '../config/index.js';
import { AgentExecutor } from '../core/agent-executor.js';
import { PurifyCenter } from '../core/purify-center.js';
import { AutoControl } from '../core/auto-control.js';
import { runExclusive } from '../core/store-base.js';

export class EvolvePurifyLoop {
  constructor(executor = new AgentExecutor(), purify = new PurifyCenter(executor.store), control = new AutoControl()) {
    this.executor = executor;
    this.purify = purify;
    this.control = control;
    this.taskQueue = [];
    this.running = false;          // 是否有任务在执行
    this.purifyTimer = null;
    this.backoffFactor = 1;        // 背压：任务队列深 → 净化间隔拉长
    this.stats = { tasks: 0, evolveBatches: 0, purifyCycles: 0, lastPurifyReport: null };
    this.onIdle = null;
  }

  start() {
    const base = CONFIG.PURIFY_LIGHT_INTERVAL_MIN * 60_000;
    const schedule = () => {
      const jitter = base * this.backoffFactor * (0.8 + Math.random() * 0.4); // ±20% 抖动（§6.4）
      this.purifyTimer = setTimeout(async () => {
        try {
          const idle = this.taskQueue.length === 0 && !this.running;
          // 空闲窗口优先净化；忙时降频一半（背压，§6.4）
          if (!idle) this.backoffFactor = Math.min(4, this.backoffFactor * 2);
          else this.backoffFactor = 1;
          if (this.taskQueue.length > 500) { /* >500 仅保留风险净化：MVP 无风险净化维度，跳过 */ }
          else {
            const report = await runExclusive('purify-cycle', () => this.purify.runCycle({ deep: false }));
            this.stats.purifyCycles++;
            this.stats.lastPurifyReport = report;
            if (report.quarantined?.length) console.log(`\n[净化] epoch ${report.epoch}：隔离 ${report.quarantined.length} 个实体（候选 ${report.detected.length}，跳过 ${report.skipped.length}）`);
          }
        } catch (e) {
          this.control.event('purify_error', { error: String(e?.message ?? e) });
        }
        schedule();
      }, jitter);
      this.purifyTimer.unref?.();
    };
    schedule();
    this.control.startHeartbeat();
  }

  stop() {
    if (this.purifyTimer) clearTimeout(this.purifyTimer);
    this.control.stopHeartbeat();
  }

  /** 提交任务（P0：任务永远优先） */
  submitTask(input, opts = {}) {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ input, opts, resolve, reject });
      this.drain();
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.taskQueue.length) {
        const { input, opts, resolve, reject } = this.taskQueue.shift();
        // 背压信号（§6.4）：>100 降频一半（在下次定时时生效）
        if (this.taskQueue.length > 100) this.backoffFactor = Math.max(this.backoffFactor, 2);
        try {
          const trace = await runExclusive('task', () => this.executor.runTask(input, opts));
          this.stats.tasks++;
          resolve(trace);
        } catch (e) { reject(e); }
      }
    } finally {
      this.running = false;
    }
    // 队列排空 → 进化批次收尾机会（进化钩子本身已在任务尾部异步跑）
    this.onIdle?.();
  }

  status() {
    return {
      ...this.stats,
      queueDepth: this.taskQueue.length,
      running: this.running,
      backoffFactor: this.backoffFactor,
      watchdog: this.control.watchdog(),
    };
  }
}
