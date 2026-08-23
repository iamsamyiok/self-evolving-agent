// core/auto-control.js —— L9 自愈管控观测层（轻量版）：心跳、日预算降级、事件日志
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG } from '../config/index.js';

export class AutoControl {
  constructor(dataDir = CONFIG.DATA_DIR) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, '..', 'logs'), { recursive: true });
    this.eventFile = join(dataDir, '..', 'logs', 'auto-control.log');
    this.heartbeatTimer = null;
  }

  /** 心跳：每 30s 写 data/heartbeat.json（看门狗据此判断存活） */
  startHeartbeat(extra = {}) {
    this.beat(extra);
    this.heartbeatTimer = setInterval(() => this.beat(extra), 30_000);
    this.heartbeatTimer.unref?.();
  }
  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); }

  beat(extra = {}) {
    writeFileSync(join(this.dataDir, 'heartbeat.json'), JSON.stringify({ at: Date.now(), ...extra }, null, 2));
  }

  /** 看门狗：心跳 >3min 未更新 → 异常（MVP 只报告不自动重启） */
  watchdog() {
    const p = join(this.dataDir, 'heartbeat.json');
    if (!existsSync(p)) return { ok: false, reason: 'no_heartbeat' };
    const hb = JSON.parse(readFileSync(p, 'utf8'));
    const age = Date.now() - hb.at;
    return { ok: age < 180_000, ageSec: Math.round(age / 1000) };
  }

  /** 事件留痕（风险/回滚/预算/失稳，JSONL） */
  event(type, detail) {
    const line = JSON.stringify({ at: Date.now(), type, ...detail });
    try { writeFileSync(this.eventFile, line + '\n', { flag: 'a' }); } catch { /* 日志失败不阻断主流程 */ }
    console.log(`[auto-control] ${type}`, detail ?? '');
  }
}
