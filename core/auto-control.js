// core/auto-control.js —— L9 自愈管控观测层（§8/§6.2.5/§6.2.6）：心跳、三层预算、自动调参（界内）、策略净化、快照回滚、看门狗
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG, BOUNDS, assertInBounds } from '../config/index.js';
import { getUsage, budgetExhausted } from './llm-adapter.js';
import { selfCheck } from './safety-constitution.js';
import { uuid7 } from './store-base.js';

export class AutoControl {
  constructor(store, dataDir = CONFIG.DATA_DIR) {
    this.store = store;
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, '..', 'logs'), { recursive: true });
    this.eventFile = join(dataDir, '..', 'logs', 'auto-control.log');
    this.heartbeatTimer = null;
  }

  /** 启动自检（§4.1.2）：宪法哈希 → 迁移 → 快照目录可写 → 心跳。失败项返回降级建议 */
  startupCheck() {
    const issues = [];
    const c = selfCheck(this.store);
    if (!c.ok) {
      issues.push(`安全宪法哈希不匹配（${c.prev} → ${c.now}）：有人改了红线代码`);
      this.event('constitution_mismatch', c);
    } else if (c.registered) {
      this.event('constitution_registered', { version: 'v1' });
    }
    try {
      const s = this.store.snapshot('startup-check');
      if (!s?.sha256) issues.push('快照目录不可写');
    } catch (e) {
      issues.push(`快照失败: ${e.message}`);
    }
    this.beat();
    return { ok: issues.length === 0, issues };
  }

  startHeartbeat(extra = {}) {
    this.beat(extra);
    this.heartbeatTimer = setInterval(() => this.beat(extra), 30_000);
    this.heartbeatTimer.unref?.();
  }
  stopHeartbeat() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); }

  beat(extra = {}) {
    try {
      writeFileSync(join(this.dataDir, 'heartbeat.json'), JSON.stringify({ at: Date.now(), pid: process.pid, ...extra }, null, 2));
    } catch { /* 心跳失败不阻断 */ }
  }

  watchdog() {
    const p = join(this.dataDir, 'heartbeat.json');
    if (!existsSync(p)) return { ok: false, reason: 'no_heartbeat' };
    const hb = JSON.parse(readFileSync(p, 'utf8'));
    const age = Date.now() - hb.at;
    return { ok: age < 180_000, ageSec: Math.round(age / 1000), pid: hb.pid };
  }

  event(type, detail) {
    const line = JSON.stringify({ at: Date.now(), type, ...detail });
    try { writeFileSync(this.eventFile, line + '\n', { flag: 'a' }); } catch { /* 日志失败不阻断主流程 */ }
    this.store?.setState?.(`event:${type}:${Date.now() % 100000}`, detail);
    console.log(`[auto-control] ${type}`, detail ?? '');
  }

  // ── 三层预算状态（§8.3）──
  budgetStatus() {
    const day = getUsage();
    return {
      day: { used: day.tokensIn + day.tokensOut, budget: CONFIG.DAILY_TOKEN_BUDGET, exhausted: budgetExhausted() },
      note: '任务预算 L1 / 净化周期预算 L2 由执行内核与净化中枢按标签实时检查',
    };
  }

  /**
   * 自动调参（§6.2.5/§8.3.1）：检索权重界内微调，步长 ≤10%，黄金门禁，全程留痕。
   * 触发：深度净化周期后；方向：任务成功率上升 → 保持；下降 → 回退上一步。
   */
  async tune({ executor } = {}) {
    if (!CONFIG.AUTO_TUNE || !executor) return null;
    const store = this.store;
    const cur = store.getState('tuned_retrieval', { sim: 0.6, quality: 0.25, recency: 0.15 });
    const last = store.getState('tuned_retrieval_last', null);

    // 任务成功率信号（最近 20 个任务）
    const tasks = store.db.prepare("SELECT outcome FROM tasks WHERE status != 'running' ORDER BY created_at DESC LIMIT 20").all();
    if (tasks.length < 10) return { skipped: 'insufficient_tasks' };
    const successRate = tasks.filter((t) => t.outcome === 'SUCCESS').length / tasks.length;
    const prevRate = store.getState('task_success_ema', successRate);
    const declining = successRate < prevRate - 0.02;

    if (declining && last) {
      // 回退上一步调参（可回退性）
      store.setState('tuned_retrieval', last);
      store.logTune({ keyName: 'tuned_retrieval', oldValue: cur, newValue: last, reason: `任务成功率下降（${(prevRate * 100).toFixed(1)}% → ${(successRate * 100).toFixed(1)}%），回退`, goldenGate: 0 });
      store.setState('task_success_ema', successRate);
      return { action: 'reverted', to: last };
    }

    // 微调方向：sim 权重 +步长（向 0.7 逼近），quality 相应减（归一约束）
    const step = (b) => (b[2] - b[1]) * 0.1; // 步长=界宽10%（§6.2.5）
    const next = { ...cur };
    next.sim = Math.min(BOUNDS.W_SIM[2], +(cur.sim + step(BOUNDS.W_SIM)).toFixed(3));
    next.quality = Math.max(BOUNDS.W_QUALITY[0], +(cur.quality - step(BOUNDS.W_QUALITY)).toFixed(3));
    next.recency = +(1 - next.sim - next.quality).toFixed(3);
    if (next.recency < BOUNDS.W_RECENCY[0] || next.recency > BOUNDS.W_RECENCY[1]) return { skipped: 'bounds' };

    // 黄金门禁（§10.1：加载策略权重变更必须过回归门禁；影子重排 top-K 重合率 ≥80%）
    let gate = { pass: true, note: 'no_executor_gate' };
    if (executor) {
      gate = await this.shadowRankGate(executor, cur, next);
    }
    store.setState('task_success_ema', successRate);
    if (!gate.pass) {
      store.logTune({ keyName: 'tuned_retrieval', oldValue: cur, newValue: next, reason: '黄金门禁未过，放弃本次调参', goldenGate: 1 });
      return { action: 'gate_failed', gate };
    }
    store.setState('tuned_retrieval_last', cur);
    store.setState('tuned_retrieval', next);
    store.logTune({ keyName: 'tuned_retrieval', oldValue: cur, newValue: next, reason: '成功率稳定，界内微调（步长 ≤10%）', goldenGate: 1 });
    return { action: 'tuned', from: cur, to: next };
  }

  /** 影子重排门禁：新旧权重对黄金任务 top-K 检索重合率 ≥80% 才放行（零 LLM 成本） */
  async shadowRankGate(executor, cur, next) {
    const golden = executor.store.db.prepare('SELECT input FROM golden_tasks WHERE enabled = 1 LIMIT 10').all();
    if (!golden.length) return { pass: true, note: 'golden_empty' };
    let overlapSum = 0, n = 0;
    for (const g of golden) {
      const a = (await executor.memory.retrieve(g.input, 5, cur)).map((r) => r.row.id);
      const b = (await executor.memory.retrieve(g.input, 5, next)).map((r) => r.row.id);
      if (!a.length && !b.length) continue;
      const inter = a.filter((x) => b.includes(x)).length;
      overlapSum += inter / Math.max(a.length, b.length, 1);
      n++;
    }
    const overlap = n ? overlapSum / n : 1;
    return { pass: overlap >= 0.8, overlap: Number(overlap.toFixed(3)) };
  }

  /**
   * 策略净化（§6.2.5）：plan 类失败占比周环比上升 >10pp → Prompt 迭代（影子版 → 黄金门禁 → 双轨切换）。
   */
  async strategyPurify({ executor } = {}) {
    if (!executor) return null;
    const store = this.store;
    const exps = store.list('experience', "WHERE state = 'ACTIVE' AND failure_taxonomy = 'plan'");
    const allFail = store.list('experience', "WHERE state = 'ACTIVE' AND failure_taxonomy IS NOT NULL");
    const planShare = allFail.length ? exps.length / allFail.length : 0;
    const prevShare = store.getState('plan_fail_share', planShare);
    store.setState('plan_fail_share', planShare);

    const rose = planShare - prevShare;
    if (rose <= 0.10 || allFail.length < 5) return { action: 'none', planShare: Number(planShare.toFixed(2)) };

    // Prompt 迭代（LLM 生成 shadow v(n+1)；预算守卫；弃权则不动）
    if (budgetExhausted()) return { action: 'skipped_budget' };
    const active = store.activePrompt('planner');
    const { chatJson } = await import('./llm-adapter.js');
    const out = await chatJson({
      messages: [
        { role: 'system', content: '你是Prompt迭代器。基于失败现象优化规划器系统提示词。输出 JSON：{"prompt":"..."}' },
        { role: 'user', content: `当前提示词：${active?.content ?? ''}\n失败现象：plan 类失败占比 ${(planShare * 100).toFixed(0)}%（周环比 +${(rose * 100).toFixed(0)}pp）` },
      ],
      validate: (v) => (typeof v?.prompt !== 'string' || v.prompt.length < 20 ? '须含实质 prompt' : null),
      label: 'strategy-purify',
    });
    if (!out?.prompt) return { action: 'llm_abstain' };

    const version = (active?.version ?? 0) + 1;
    const id = uuid7();
    store.insertPrompt({ id, role: 'planner', version, content: out.prompt, sha256: createHash('sha256').update(out.prompt).digest('hex'), status: 'shadow' });

    // 黄金门禁：shadow 生效跑黄金子集，回归 ≤2pp 才切换（双轨保留，劣化自动回退=直接 retire）
    const candidate = {
      apply: () => { store.setPromptStatus(id, 'active'); store.setPromptStatus(active.id, 'retired'); },
      revert: () => { store.setPromptStatus(id, 'retired'); store.setPromptStatus(active.id, 'active'); },
    };
    const gate = await executor.goldenGate({ candidate });
    if (!gate.pass) {
      store.setPromptStatus(id, 'retired');
      this.event('prompt_gate_failed', { version, regression: gate.regressionPp });
      return { action: 'gate_failed', gate };
    }
    this.event('prompt_upgraded', { role: 'planner', version, baseline: gate.baseline, after: gate.after });
    return { action: 'upgraded', version, gate };
  }

  /**
   * 快照回滚（§6.2.6 风险净化执行端）：关闭库 → 快照覆盖 → 重开 → 事件留痕。
   */
  rollbackSnapshot(snapshotFile) {
    const src = join(this.dataDir, 'snapshots', snapshotFile);
    if (!existsSync(src)) return { ok: false, reason: `快照不存在: ${snapshotFile}` };
    const StoreClass = getStoreClass();
    if (!StoreClass) return { ok: false, reason: 'Store 未绑定（app.js 启动时 bindStoreClass）' };
    this.store.close();
    const dbPath = join(this.dataDir, 'agent.db');
    copyFileSync(src, dbPath + '.rollback-bak');
    copyFileSync(src, dbPath);
    for (const ext of ['-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) unlinkSync(p);
    }
    const fresh = new StoreClass(this.dataDir);
    // 外壳重绑：保持引用不变的前提下接管新库句柄
    this.store.reattach(fresh);
    this.event('snapshot_rollback', { snapshot: snapshotFile });
    return { ok: true, restored: snapshotFile };
  }

  /** 反指标巡检（§12.3）：任一触发 → 告警事件 */
  checkCounterMetrics() {
    const store = this.store;
    const alerts = [];
    // 任务成功率 7 日窗口回撤 >5pp（用最近任务 EMA 近似）
    const tasks = store.db.prepare("SELECT outcome, created_at FROM tasks WHERE status != 'running' ORDER BY created_at DESC LIMIT 100").all();
    if (tasks.length >= 20) {
      const half = Math.floor(tasks.length / 2);
      const newer = tasks.slice(0, half), older = tasks.slice(half);
      const rNew = newer.filter((t) => t.outcome === 'SUCCESS').length / half;
      const rOld = older.filter((t) => t.outcome === 'SUCCESS').length / half;
      if (rOld - rNew > 0.05) alerts.push({ type: 'success_drawdown', from: rOld, to: rNew });
    }
    // 单日变更率触顶连续 3 天
    const churnStreak = [0, 1, 2].map((d) => {
      const key = `churn:${new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)}`;
      return store.getState(key, 0);
    });
    if (churnStreak.every((c) => c > 0)) alerts.push({ type: 'churn_cap_streak', days: churnStreak });
    // 看门狗 24h 内重启 >3 次
    const restarts = store.getState('restart_count_day', { day: '', count: 0 });
    if (restarts.count > 3) alerts.push({ type: 'watchdog_restarts', count: restarts.count });
    for (const a of alerts) this.event('counter_metric', a);
    return alerts;
  }
}

// 供 rollback 使用的 Store 引用注入（app.js 启动时调用）
export function bindStoreClass(StoreClass) { globalThis.__spa_Store = StoreClass; }
function getStoreClass() { return globalThis.__spa_Store; }
