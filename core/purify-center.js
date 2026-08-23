// core/purify-center.js —— L7 全局自净化中枢【系统核心】（§6）
// MVP 管线范围（指导书 §11.1）：① DETECT → ② VERIFY → ③ QUARANTINE → ⑤ RECORD（④ EXECUTE/⑥ REVIEW 属第二阶段）
// 维度范围：记忆 + 经验 + 数据（技能净化属第二阶段）
// 纪律：先写 purge_logs 再执行状态变更；软删优先；n≥5；免疫期；变更率上限；快照前置；全程可回滚。
import { CONFIG } from '../config/index.js';
import { Store, runExclusive } from './store-base.js';
import { candidatePairs, jaccard, tokenize } from '../utils/similarity.js';
import { wilsonLowerBound, memoryImportance, netRate } from '../utils/stats.js';
import { budgetExhausted } from './llm-adapter.js';

export class PurifyCenter {
  constructor(store = new Store()) {
    this.store = store;
  }

  /**
   * 执行一轮净化周期（light 轻量 / deep 深度）。
   * 返回报告：{ epoch, snapshot, detected, quarantined, skipped, churn, netRate }
   */
  async runCycle({ deep = false } = {}) {
    const store = this.store;
    const epoch = store.bumpEpoch();
    const now = Date.now();
    const report = { epoch, deep, detected: [], quarantined: [], skipped: [], errors: [] };

    // ── 崩溃恢复前置：上轮 EXECUTING 未收尾的日志先收尾（§7.2）──
    this.recoverInterrupted();

    // ── ① DETECT 检测（纯本地计算，零 LLM 成本）──
    const detectTs = now;
    const candidates = this.detect(now);
    for (const c of candidates) c.detectedAt = detectTs;
    report.detected = candidates.map((c) => `${c.entityType}:${c.kind}`);

    if (!candidates.length) { report.snapshot = null; return report; }

    // ── 快照前置（§6.3-4）：有实质变更候选才生成 ──
    report.snapshot = store.snapshot(deep ? 'deep-purify' : 'light-purify');

    // 变更率上限预算（单周期 ≤5%，单日 ≤20% 活性实体；小规模系统保底配额 1，否则永无净化机会）
    const activeTotal = this.activeEntityCount();
    let churnQuota = Math.max(1, Math.floor(activeTotal * CONFIG.PURIFY_CHURN_LIMIT));
    const dayKey = `churn:${new Date().toISOString().slice(0, 10)}`;
    const dayChurned = store.getState(dayKey, 0);
    let dayQuota = Math.max(1, Math.ceil(activeTotal * CONFIG.PURIFY_DAILY_CHURN_LIMIT) - dayChurned);
    report.quota = { activeTotal, cycle: churnQuota, dayLeft: dayQuota };

    // ── ② VERIFY → ③ QUARANTINE → ⑤ RECORD（逐候选；任何一步弃权则本轮跳过，下轮再议）──
    for (const cand of candidates) {
      if (churnQuota <= 0 || dayQuota <= 0) { report.skipped.push({ id: cand.id, reason: 'churn_limit' }); continue; }
      const gate = this.verify(cand, now);
      if (!gate.ok) { report.skipped.push({ id: cand.id, reason: gate.reason }); continue; }
      try {
        const done = await this.quarantine(cand, { epoch, snapshotId: report.snapshot.id, gate });
        if (done) {
          churnQuota--; dayQuota--;
          store.setState(dayKey, store.getState(dayKey, 0) + 1);
          report.quarantined.push(`${cand.entityType}:${cand.id}`);
        }
      } catch (e) {
        report.errors.push(`${cand.id}: ${e.message}`);
      }
    }

    // ── TTL 清扫：隔离区到期 → 硬清除 + 墓碑（§6.5-3）──
    await this.sweepExpired(now);

    // ── 净利率稳态记录（§1.4 / §12.2）──
    report.netRate = this.recordNetRate();
    return report;
  }

  // ═════════ ① DETECT：纯本地候选扫描 ═════════
  detect(now) {
    const out = [];

    // ── 记忆维度（§6.2.1）──
    const memories = this.store.list('memory', "WHERE state = 'ACTIVE'");
    for (const m of memories) {
      if (m.tier === 'short' && m.expires_at && m.expires_at < now) {
        out.push({ entityType: 'memory', id: m.id, kind: 'expired', rule: true, evidence: { expires_at: m.expires_at } });
      }
      if (m.tier === 'long') {
        const I = memoryImportance({ importance: m.importance, tier: m.tier, accessCount: m.access_count, createdAt: m.created_at, now });
        if (I < CONFIG.MEMORY_KEEP_LINE && m.access_count >= CONFIG.MIN_EVIDENCE_N) {
          out.push({ entityType: 'memory', id: m.id, kind: 'low_value', rule: false, evidence: { importance_now: Number(I.toFixed(3)), line: CONFIG.MEMORY_KEEP_LINE, n: m.access_count } });
        }
      }
    }
    // 冗余记忆：同 tier 高相似对 → 保留 I 值高者，另一条候选
    const byTier = {};
    for (const m of memories) (byTier[m.tier] ??= []).push(m);
    for (const tier of ['short', 'long']) {
      const group = byTier[tier] ?? [];
      if (group.length < 2) continue;
      for (const p of candidatePairs(group.map((m) => ({ id: m.id, text: m.content })))) {
        if (p.jaccard < CONFIG.MEMORY_DUP_JACCARD) continue;
        const a = group.find((m) => m.id === p.a), b = group.find((m) => m.id === p.b);
        const Ia = memoryImportance({ importance: a.importance, tier, accessCount: a.access_count, createdAt: a.created_at, now });
        const Ib = memoryImportance({ importance: b.importance, tier, accessCount: b.access_count, createdAt: b.created_at, now });
        const loser = Ia >= Ib ? b : a;
        out.push({ entityType: 'memory', id: loser.id, kind: 'redundant', rule: true, evidence: { dup_with: loser === a ? b.id : a.id, jaccard: Number(p.jaccard.toFixed(3)) } });
      }
    }

    // ── 经验维度（§6.2.2）──
    const experiences = this.store.list('experience', "WHERE state = 'ACTIVE'");
    for (const e of experiences) {
      const staleDays = (now - (e.last_used_at ?? e.created_at)) / 86_400_000;
      if (staleDays >= CONFIG.EXPERIENCE_STALE_DAYS) {
        out.push({ entityType: 'experience', id: e.id, kind: 'stale', rule: true, evidence: { stale_days: Math.round(staleDays) } });
        continue; // 同一实体一个周期只走一条原因
      }
      const n = e.execution_count || e.sample_count;
      const w = wilsonLowerBound(e.success_count, n);
      if (w < CONFIG.SKILL_PURGE_W && n >= CONFIG.MIN_EVIDENCE_N) {
        out.push({ entityType: 'experience', id: e.id, kind: 'low_quality', rule: false, evidence: { wilson: Number(w.toFixed(3)), n, line: CONFIG.SKILL_PURGE_W } });
      }
    }
    // 重复经验：签名相似 → 保留证据更充分者
    if (experiences.length >= 2) {
      const seen = new Set();
      for (const p of candidatePairs(experiences.map((e) => ({ id: e.id, text: e.task_signature })))) {
        if (p.jaccard < 0.90) continue;
        const a = experiences.find((e) => e.id === p.a), b = experiences.find((e) => e.id === p.b);
        if (seen.has(a.id) || seen.has(b.id)) continue;
        const loser = a.sample_count >= b.sample_count ? b : a;
        seen.add(loser.id);
        out.push({ entityType: 'experience', id: loser.id, kind: 'duplicate', rule: true, evidence: { dup_with: loser === a ? b.id : a.id, jaccard: Number(p.jaccard.toFixed(3)) } });
      }
    }

    // ── 数据维度（§6.2.4）：坏行检测（JSON 字段损坏 → lost_and_found，禁止原地改写）──
    for (const e of this.store.list('experience', "WHERE state IN ('ACTIVE','DEPRECATED')")) {
      if (!this.safeParseArray(e.rules) || !this.safeParseArray(e.pitfalls) || !this.safeParseArray(e.evidence)) {
        out.push({ entityType: 'experience', id: e.id, kind: 'corrupt_row', rule: true, evidence: { fields: 'rules/pitfalls/evidence' } });
      }
    }
    for (const s of this.store.list('skill', "WHERE state IN ('DRAFT','ACTIVE','COOLING')")) {
      if (!this.safeParseArray(s.steps)) {
        out.push({ entityType: 'skill', id: s.id, kind: 'corrupt_row', rule: true, evidence: { fields: 'steps' } });
      }
    }
    // 同一实体同周期只保留一条净化原因（优先首个规则性原因）
    const seen = new Set();
    return out.filter((c) => (seen.has(c.entityType + ':' + c.id) ? false : (seen.add(c.entityType + ':' + c.id), true)));
  }

  safeParseArray(s) {
    try { const v = JSON.parse(s); return Array.isArray(v); } catch { return false; }
  }

  // ═════════ ② VERIFY 复核（客观证据核对，§6.1-2a）═════════
  verify(cand, now) {
    const row = this.store.get(cand.entityType, cand.id);
    if (!row) return { ok: false, reason: 'gone' };

    // a) 免疫期（新建实体 48h 净化豁免）
    if (row.immunity_until > now) return { ok: false, reason: 'immunity' };

    // b) 最小证据（n≥5；仅约束质量类淘汰，规则类过期/冗余/坏行不受此限）
    if (!cand.rule) {
      const n = cand.entityType === 'experience'
        ? (row.execution_count || row.sample_count)
        : row.access_count ?? row.execution_count;
      if (n < CONFIG.MIN_EVIDENCE_N) return { ok: false, reason: `min_evidence(n=${n})` };
    }

    // c) 冷却期：进化写入后 24h 内净化豁免（epoch 校验实现，§6.5-2）
    if (now - row.updated_at < 24 * 3600_000 && cand.kind !== 'corrupt_row') {
      return { ok: false, reason: 'cooldown' };
    }

    // d) epoch 复查：检测后未被并发改写（§3.5）
    if (cand.detectedAt && row.updated_at > cand.detectedAt) {
      return { ok: false, reason: 'concurrent_write' };
    }
    return { ok: true, checks: { state: row.state, version: row.version } };
  }

  // ═════════ ③ QUARANTINE + ⑤ RECORD：先留痕、后变更、再收尾 ═════════
  async quarantine(cand, { epoch, snapshotId, gate }) {
    return runExclusive(`${cand.entityType}:${cand.id}`, () => {
      const row = this.store.get(cand.entityType, cand.id);
      if (!row) return false;
      const now = Date.now();

      // 坏行先转移 lost_and_found（禁止原地改写）
      if (cand.kind === 'corrupt_row') this.store.moveToLostAndFound(cand.entityType, row, `corrupt:${cand.evidence.fields}`);

      // 状态链合法化（§3.3：只能经合法路径到达 QUARANTINED）
      if (cand.entityType === 'memory' && cand.kind === 'expired' && row.state === 'ACTIVE') {
        this.store.transition('memory', cand.id, 'EXPIRED');
      }
      if (cand.entityType === 'experience' && row.state === 'ACTIVE' && cand.kind === 'stale') {
        this.store.transition('experience', cand.id, 'DEPRECATED');
      }
      if (cand.entityType === 'skill' && row.state === 'DRAFT') {
        this.store.transition('skill', cand.id, 'REJECTED');
      }

      const logId = this.store.logPurge({
        epoch, entityType: cand.entityType, entityId: cand.id,
        action: cand.kind === 'expired' ? 'EXPIRE' : cand.kind === 'corrupt_row' ? 'LOST_AND_FOUND' : 'QUARANTINE',
        dimension: cand.entityType === 'skill' ? 'data' : cand.entityType === 'memory' ? 'memory' : 'experience',
        reason: `kind=${cand.kind}`,
        evidence: { ...cand.evidence, prev_state: row.state, prev_version: row.version, quality_score: row.quality_score },
        confidence: cand.rule ? 1.0 : 0.8,
        judgeMeta: null, // MVP：判定器仅在进化侧冲突检测与任务判定使用；净化侧全客观信号
        snapshotId,
        status: 'EXECUTING',
      });
      try {
        this.store.transition(cand.entityType, cand.id, 'QUARANTINED', {
          quarantined_at: now,
          purge_after: now + CONFIG.QUARANTINE_TTL_DAYS * 86_400_000,
        });
        this.store.markPurgeDone(logId);
        return true;
      } catch (e) {
        this.store.markPurgeRolledBack(logId);
        throw e;
      }
    });
  }

  // ═════════ TTL 清扫：PURGED + 墓碑 ═════════
  async sweepExpired(now = Date.now()) {
    const swept = [];
    const jobs = [];
    for (const type of ['memory', 'experience', 'skill']) {
      for (const row of this.store.list(type, "WHERE state = 'QUARANTINED' AND purge_after < ?", [now])) {
        const p = runExclusive(`${type}:${row.id}`, () => {
          const logId = this.store.logPurge({
            epoch: this.store.epoch, entityType: type, entityId: row.id, action: 'PURGE',
            dimension: type, reason: 'ttl_expired',
            evidence: { ttl_days: CONFIG.QUARANTINE_TTL_DAYS }, confidence: 1, snapshotId: null, status: 'EXECUTING',
          });
          this.store.transition(type, row.id, 'PURGED');
          this.store.addTombstone(type, row.id, tokenize(this.digestOf(row)));
          this.store.hardDelete(type, row.id);
          this.store.markPurgeDone(logId);
        });
        jobs.push(p);
        swept.push(`${type}:${row.id}`);
      }
    }
    await Promise.all(jobs);
    return swept;
  }

  digestOf(row) {
    return row.content ?? row.summary ?? row.description ?? row.name ?? row.id;
  }

  // ═════════ 隔离区恢复（回滚：复审翻案 / 一键恢复，§6.3-5）═════════
  async restore(entityId) {
    for (const type of ['memory', 'experience', 'skill']) {
      const row = this.store.get(type, entityId);
      if (!row) continue;
      if (row.state !== 'QUARANTINED') return { ok: false, reason: `state=${row.state}（仅 QUARANTINED 可恢复）` };
      return runExclusive(`${type}:${entityId}`, () => {
        this.store.transition(type, entityId, 'ACTIVE', { quarantined_at: null, purge_after: null });
        this.store.logPurge({ epoch: this.store.epoch, entityType: type, entityId, action: 'RESTORE', dimension: type, reason: 'manual_restore', evidence: { from: 'QUARANTINED' }, confidence: 1, status: 'DONE' });
        return { ok: true, entityId, type, restored_to: 'ACTIVE' };
      });
    }
    return { ok: false, reason: 'not_found' };
  }

  // ═════════ 崩溃恢复（§7.2：重启后扫描 EXECUTING 日志收尾）═════════
  recoverInterrupted() {
    const rows = this.store.executingPurges();
    const fixed = [];
    for (const log of rows) {
      const entity = this.store.get(log.entity_type, log.entity_id);
      if (entity && entity.state === 'QUARANTINED') {
        this.store.markPurgeDone(log.id); // 变更已执行、DONE 未落 → 补记
        fixed.push(`${log.entity_id}: done`);
      } else {
        this.store.markPurgeRolledBack(log.id); // 变更未执行 → 视为本轮回滚
        fixed.push(`${log.entity_id}: rolled_back`);
      }
    }
    return fixed;
  }

  activeEntityCount() {
    let n = 0;
    for (const t of ['memory', 'experience', 'skill']) {
      n += this.store.list(t, "WHERE state IN ('ACTIVE','DRAFT','COOLING','DEPRECATED','EXPIRED','FROZEN','REJECTED')").length;
    }
    return n;
  }

  /** 净利率记录（进化新增 Q − 净化清除 Q）/ 总 Q；连续 3 周期 |nr|>20% 记失稳事件 */
  recordNetRate() {
    const store = this.store;
    const addedQ = store.getState('evolve_added_q', 0);
    const removedQ = store.getState('purify_removed_q', 0);
    let totalQ = 0;
    for (const t of ['memory', 'experience', 'skill']) {
      for (const r of store.list(t, "WHERE state IN ('ACTIVE','DRAFT','COOLING','DEPRECATED','EXPIRED')")) totalQ += r.quality_score;
    }
    const nr = netRate(addedQ, removedQ, totalQ);
    const history = store.getState('net_rate_history', []);
    history.push(Number(nr.toFixed(4)));
    store.setState('net_rate_history', history.slice(-10));
    if (history.slice(-3).every((x) => Math.abs(x) > 0.2)) {
      store.setState('instability_event', { at: Date.now(), history: history.slice(-3) });
    }
    // 周期重置滚动累计
    store.setState('evolve_added_q', 0);
    store.setState('purify_removed_q', 0);
    return Number(nr.toFixed(4));
  }

  /** 预算触顶降级（§8.3-L3 轻量版）：仅执行零 LLM 成本的规则性净化 */
  isDegraded() { return budgetExhausted(); }
}
