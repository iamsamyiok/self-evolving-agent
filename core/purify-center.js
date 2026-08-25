// core/purify-center.js —— L7 全局自净化中枢【系统核心】（§6）
// v0.2 全维度：记忆+经验+技能+数据+策略+风险；六步管线完整（④修复合并 ⑥复审抽样）；
// 反振荡全套（迟滞/冷却/墓碑/对抗计数/稳态断言）；安全五原则；三层预算联动。
import { CONFIG } from '../config/index.js';
import { Store, runExclusive, uuid7 } from './store-base.js';
import { candidatePairs, jaccard, tokenize } from '../utils/similarity.js';
import { wilsonLowerBound, memoryImportance, netRate, qualityScore } from '../utils/stats.js';
import { budgetExhausted, labelBudgetLeft, chatJson, judge } from './llm-adapter.js';
import { backfillOne } from './embed-backfill.js';

export class PurifyCenter {
  constructor(store = new Store(), executor = null) {
    this.store = store;
    this.executor = executor; // 策略净化需要跑黄金门禁
  }

  /**
   * 执行一轮净化周期（light 轻量 / deep 深度）。
   */
  async runCycle({ deep = false } = {}) {
    const store = this.store;
    const epoch = store.bumpEpoch();
    const label = `purify:${epoch}`;
    const now = Date.now();
    const report = { epoch, deep, detected: [], quarantined: [], skipped: [], merged: [], repaired: [], reviewed: [], errors: [] };

    this.recoverInterrupted();

    // ── ① DETECT 检测（纯本地计算，零 LLM 成本）──
    const detectTs = now;
    let candidates = this.detect(now);
    // 深度净化附加：技能维度 + 反振荡对抗检查 + 稳态断言
    if (deep) {
      candidates.push(...this.detectSkills(now));
    }
    for (const c of candidates) c.detectedAt = detectTs;
    report.detected = candidates.map((c) => `${c.entityType}:${c.kind}`);

    if (candidates.length) {
      // 快照前置（§6.3-4）
      report.snapshot = store.snapshot(deep ? 'deep-purify' : 'light-purify');

      // 变更率预算（单周期 ≤5%，单日 ≤20%；小系统保底 1）
      const activeTotal = this.activeEntityCount();
      let churnQuota = Math.max(1, Math.floor(activeTotal * CONFIG.PURIFY_CHURN_LIMIT));
      const dayKey = `churn:${new Date().toISOString().slice(0, 10)}`;
      let dayQuota = Math.max(1, Math.ceil(activeTotal * CONFIG.PURIFY_DAILY_CHURN_LIMIT) - store.getState(dayKey, 0));

      // ── ② VERIFY → ③ QUARANTINE / ④ EXECUTE → ⑤ RECORD ──
      for (const cand of candidates) {
        if (churnQuota <= 0 || dayQuota <= 0) { report.skipped.push({ id: cand.id, reason: 'churn_limit' }); continue; }
        const gate = this.verify(cand, now);
        if (!gate.ok) { report.skipped.push({ id: cand.id, reason: gate.reason }); continue; }
        try {
          // ④ EXECUTE：修复/合并类（走 LLM 生成新版本，旧实体进隔离区；预算不足则降级为纯隔离）
          if (cand.kind === 'redundant_memory' || cand.kind === 'redundant_skill' || cand.kind === 'duplicate_exp') {
            const merged = await this.executeMerge(cand, { epoch, snapshotId: report.snapshot.id, label });
            if (merged) { report.merged.push(`${cand.entityType}:${cand.id}`); }
          } else if (cand.kind === 'error_skill') {
            const repaired = await this.executeRepair(cand, { epoch, snapshotId: report.snapshot.id, label });
            if (repaired) { report.repaired.push(`skill:${cand.id}`); }
          }
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
    }

    // ── 技能 FROZEN 观察期收尾（§6.2.3：冻结 7 天无起色 → 隔离；有起色 → 回 ACTIVE）──
    if (deep) report.frozen = this.settleFrozen(now);

    // ── ⑥ REVIEW 复审抽样（隔离区 TTL 内随机抽 10%，翻案率=净化精确率度量）──
    if (deep) report.review = await this.reviewSampled({ label });

    // ── 反振荡：对抗计数（血缘链 3 次生成-被净化 → 冻结整链）+ 稳态断言 ──
    if (deep) report.adversarial = this.checkAdversarial();

    // ── TTL 清扫：隔离区到期 → 硬清除 + 墓碑（§6.5-3）──
    await this.sweepExpired(now);

    // ── 风险净化：净利率破线 → 自动回滚最近快照（§6.2.6，回滚本身就是净化）──
    report.netRate = this.recordNetRate();
    if (deep && CONFIG.AUTO_ROLLBACK) report.risk = await this.riskGuard(report.netRate);

    return report;
  }

  // ═════════ ① DETECT：记忆/经验/数据维度（同 v0.1）═════════
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
        out.push({ entityType: 'memory', id: loser.id, kind: 'redundant_memory', rule: true, evidence: { dup_with: loser === a ? b.id : a.id, jaccard: Number(p.jaccard.toFixed(3)) } });
      }
    }

    // ── 经验维度（§6.2.2）──
    const experiences = this.store.list('experience', "WHERE state = 'ACTIVE'");
    for (const e of experiences) {
      const staleDays = (now - (e.last_used_at ?? e.created_at)) / 86_400_000;
      if (staleDays >= CONFIG.EXPERIENCE_STALE_DAYS) {
        out.push({ entityType: 'experience', id: e.id, kind: 'stale', rule: true, evidence: { stale_days: Math.round(staleDays) } });
        continue;
      }
      const n = e.execution_count || e.sample_count;
      const w = wilsonLowerBound(e.success_count, n);
      if (w < CONFIG.SKILL_PURGE_W && n >= CONFIG.MIN_EVIDENCE_N) {
        out.push({ entityType: 'experience', id: e.id, kind: 'low_quality', rule: false, evidence: { wilson: Number(w.toFixed(3)), n, line: CONFIG.SKILL_PURGE_W } });
      }
    }
    if (experiences.length >= 2) {
      const seen = new Set();
      for (const p of candidatePairs(experiences.map((e) => ({ id: e.id, text: e.task_signature })))) {
        if (p.jaccard < 0.90) continue;
        const a = experiences.find((e) => e.id === p.a), b = experiences.find((e) => e.id === p.b);
        if (seen.has(a.id) || seen.has(b.id)) continue;
        const loser = a.sample_count >= b.sample_count ? b : a;
        seen.add(loser.id);
        out.push({ entityType: 'experience', id: loser.id, kind: 'duplicate_exp', rule: true, evidence: { dup_with: loser === a ? b.id : a.id, jaccard: Number(p.jaccard.toFixed(3)) } });
      }
    }

    // ── 数据维度（§6.2.4）：坏行 ──
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
    return this.dedupCandidates(out);
  }

  // ═════════ ① DETECT（技能维度，§6.2.3，仅深度净化）═════════
  detectSkills(now) {
    const out = [];
    const skills = this.store.list('skill', "WHERE state IN ('ACTIVE','COOLING')");
    for (const s of skills) {
      const idleDays = (now - (s.last_used_at ?? s.created_at)) / 86_400_000;
      // 僵尸技能：30 天零调用零迭代
      if (idleDays >= CONFIG.SKILL_ZOMBIE_DAYS) {
        out.push({ entityType: 'skill', id: s.id, kind: 'zombie_skill', rule: true, evidence: { idle_days: Math.round(idleDays) } });
        continue;
      }
      // 劣质技能：W ≤ 淘汰线 且 n≥5 且过免疫期 → 先 FROZEN 观察（不走隔离，单独处理）
      const n = s.execution_count;
      const w = wilsonLowerBound(s.success_count, n);
      if (w <= CONFIG.SKILL_PURGE_W && n >= CONFIG.MIN_EVIDENCE_N) {
        out.push({ entityType: 'skill', id: s.id, kind: 'low_quality_skill', rule: false, evidence: { wilson: Number(w.toFixed(3)), n, line: CONFIG.SKILL_PURGE_W } });
      }
    }
    // 错误技能：失败占比极高 + judge 认为步骤有逻辑错误（复现校验在 executeRepair 内）
    const suspect = skills
      .filter((s) => s.execution_count >= CONFIG.MIN_EVIDENCE_N && s.fail_count / s.execution_count >= 0.8)
      .sort((a, b) => b.fail_count - a.fail_count)[0];
    if (suspect) out.push({ entityType: 'skill', id: suspect.id, kind: 'error_skill', rule: false, evidence: { fail_rate: Number((suspect.fail_count / suspect.execution_count).toFixed(2)) } });

    // 冗余技能：场景相似 ≥0.90 → 保留 verified/高 Q 者
    if (skills.length >= 2) {
      const seen = new Set();
      for (const p of candidatePairs(skills.map((s) => ({ id: s.id, text: `${s.name} ${s.scenario} ${s.description}` })))) {
        if (p.jaccard < CONFIG.SKILL_DUP_JACCARD) continue;
        const a = skills.find((s) => s.id === p.a), b = skills.find((s) => s.id === p.b);
        if (seen.has(a.id) || seen.has(b.id)) continue;
        const better = ((a.verified - b.verified) || (a.quality_score - b.quality_score)) >= 0 ? a : b;
        const loser = better === a ? b : a;
        seen.add(loser.id);
        out.push({ entityType: 'skill', id: loser.id, kind: 'redundant_skill', rule: true, evidence: { dup_with: better.id, jaccard: Number(p.jaccard.toFixed(3)) } });
      }
    }
    return this.dedupCandidates(out);
  }

  dedupCandidates(list) {
    const seen = new Set();
    return list.filter((c) => {
      const k = `${c.entityType}:${c.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  safeParseArray(s) {
    try { const v = JSON.parse(s); return Array.isArray(v); } catch { return false; }
  }

  // ═════════ ② VERIFY 复核（客观证据核对，§6.1-2a）═════════
  verify(cand, now) {
    const row = this.store.get(cand.entityType, cand.id);
    if (!row) return { ok: false, reason: 'gone' };
    if (row.immunity_until > now) return { ok: false, reason: 'immunity' };
    if (!cand.rule) {
      const n = cand.entityType === 'experience'
        ? (row.execution_count || row.sample_count)
        : cand.entityType === 'skill' ? row.execution_count
        : row.access_count ?? row.execution_count;
      if (n < CONFIG.MIN_EVIDENCE_N) return { ok: false, reason: `min_evidence(n=${n})` };
    }
    if (now - row.updated_at < 24 * 3600_000 && cand.kind !== 'corrupt_row') {
      return { ok: false, reason: 'cooldown' };
    }
    if (cand.detectedAt && row.updated_at > cand.detectedAt) {
      return { ok: false, reason: 'concurrent_write' };
    }
    // 预算降级（§8.3-L2）：周期预算耗尽 → 仅执行零 LLM 成本的规则性净化
    if (!cand.rule && labelBudgetLeft(`purify:${this.store.epoch}`, CONFIG.PURIFY_CYCLE_TOKEN_BUDGET) <= 0) {
      return { ok: false, reason: 'cycle_budget' };
    }
    return { ok: true, checks: { state: row.state, version: row.version } };
  }

  // ═════════ ④ EXECUTE-1：合并（保留高价值方并吸收证据，败者进隔离区，§6.2.1/§6.2.2/§6.2.3）═════════
  async executeMerge(cand, { epoch, snapshotId, label }) {
    const store = this.store;
    const loser = store.get(cand.entityType, cand.id);
    const winner = store.get(cand.entityType, cand.evidence.dup_with);
    if (!loser || !winner) return false;

    return runExclusive(`${cand.entityType}:${winner.id}`, async () => {
      if (cand.entityType === 'memory') {
        // LLM 合并生成新条（两旧条均进隔离区，血缘可溯）→ MVP 简化：胜者保留，内容若可合并则 LLM 合并
        let mergedContent = winner.content;
        if (labelBudgetLeft(label, CONFIG.PURIFY_CYCLE_TOKEN_BUDGET) > 0 && !budgetExhausted()) {
          const out = await chatJson({
            messages: [
              { role: 'system', content: '你是记忆合并器。把两条高度相似的记忆合并为一条，保留一致要点、标注差异。输出 JSON：{"content":"..."}' },
              { role: 'user', content: `记忆A：${winner.content}\n记忆B：${loser.content}` },
            ],
            validate: (v) => (typeof v?.content !== 'string' || v.content.length < 4 ? '须含非空 content' : null),
            label,
          });
          if (out?.content) mergedContent = out.content.slice(0, 300);
        }
        const ev = JSON.parse(winner.entities ?? 'null');
        store.update('memory', winner.id, {
          content: mergedContent,
          importance: Math.max(winner.importance, loser.importance),
          access_count: winner.access_count + loser.access_count,
          entities: ev ? JSON.stringify(ev) : winner.entities,
        });
      } else if (cand.entityType === 'experience') {
        // 吸收证据链与样本计数
        const evW = JSON.parse(winner.evidence), evL = JSON.parse(loser.evidence);
        store.update('experience', winner.id, {
          sample_count: winner.sample_count + loser.sample_count,
          success_count: winner.success_count + loser.success_count,
          fail_count: winner.fail_count + loser.fail_count,
          execution_count: winner.execution_count + loser.execution_count,
          evidence: JSON.stringify([...evW, ...evL].slice(-20)),
        });
      } else if (cand.entityType === 'skill') {
        // 合并保留 verified 版本（§6.2.3）：胜者吸收执行证据
        store.update('skill', winner.id, {
          success_count: winner.success_count + loser.success_count,
          fail_count: winner.fail_count + loser.fail_count,
          execution_count: winner.execution_count + loser.execution_count,
        });
      }
      store.logPurge({
        epoch, entityType: cand.entityType, entityId: winner.id, action: 'MERGE', dimension: cand.entityType,
        reason: `absorbed ${cand.id}`, evidence: { absorbed: cand.id, kind: cand.kind },
        confidence: 0.95, snapshotId, status: 'DONE',
      });
      return true;
    });
  }

  // ═════════ ④ EXECUTE-2：技能修复（复现校验 → 修复版 DRAFT → 门禁，§6.2.3）═════════
  async executeRepair(cand, { epoch, snapshotId, label }) {
    const store = this.store;
    const skill = store.get('skill', cand.id);
    if (!skill || !this.executor) return false;

    // 复现校验（防幻影清洗 §6.1-2c）：黄金任务上复跑该技能场景，失败可复现才允许判"步骤错误"
    const golden = store.db.prepare('SELECT * FROM golden_tasks WHERE enabled = 1').all();
    const { BM25Index } = await import('../utils/similarity.js');
    const matched = golden.length
      ? new BM25Index(golden.map((g) => ({ id: g.id, text: g.input }))).search(skill.scenario, 2)
      : [];
    if (!matched.length) return false; // 无复现条件 → 本轮跳过（宁可慢，不可错）
    let reproduced = false;
    for (const m of matched) {
      const g = golden.find((x) => x.id === m.id);
      const t = await this.executor.runTask(g.input, { assertion: JSON.parse(g.assertion), skillOverride: skill, silent: true, goldenCheck: true, label });
      if (t.outcome === 'FAIL') { reproduced = true; break; }
    }
    if (!reproduced) {
      store.logPurge({ epoch, entityType: 'skill', entityId: cand.id, action: 'REPAIR', dimension: 'skill', reason: '复现校验未通过，放弃修复判定（防幻影清洗）', evidence: { reproduced: false }, confidence: 1, snapshotId, status: 'DONE' });
      return false;
    }

    // 生成修复版（新 DRAFT，血缘链上）
    if (labelBudgetLeft(label, CONFIG.PURIFY_CYCLE_TOKEN_BUDGET) <= 0 || budgetExhausted()) return false;
    const out = await chatJson({
      messages: [
        { role: 'system', content: '你是技能修复器。根据失败现象修复技能步骤。输出 JSON：{"steps":[{"goal":"...","action":"reason|answer|tool:<名>"}]}' },
        { role: 'user', content: `技能名：${skill.name}\n场景：${skill.scenario}\n当前步骤：${skill.steps}\n失败现象：失败率 ${cand.evidence.fail_rate}` },
      ],
      validate: (v) => (!Array.isArray(v?.steps) || v.steps.length < 1 ? '须含非空 steps' : null),
      label,
    });
    if (!out?.steps) return false;

    const id = uuid7();
    const now = Date.now();
    store.insert('skill', {
      id, state: 'DRAFT', version: 1, parent_id: skill.id, origin: 'purify_repair',
      created_at: now, updated_at: now, immunity_until: now + CONFIG.IMMUNITY_HOURS * 3600_000,
      execution_count: 0, quality_score: 0.5, embedding: null,
      quarantined_at: null, purge_after: null, last_used_at: null, frozen_at: null,
      name: skill.name, scenario: skill.scenario, description: skill.description,
      steps: JSON.stringify(out.steps.slice(0, 8)),
      params_schema: skill.params_schema, success_count: 0, fail_count: 0, verified: 0, heat: 'warm',
    });
    backfillOne(store, 'skill', id); // 异步补语义向量
    store.logPurge({
      epoch, entityType: 'skill', entityId: id, action: 'REPAIR', dimension: 'skill',
      reason: `修复 ${skill.id}（失败可复现）`, evidence: { parent: skill.id, reproduced: true },
      confidence: 0.9, snapshotId, status: 'DONE',
    });
    // 修复版走 DRAFT 门禁
    this.executor.skills.verifyDraft(id).catch(() => {});
    return true;
  }

  // ═════════ ③ QUARANTINE + ⑤ RECORD ═════════
  async quarantine(cand, { epoch, snapshotId, gate }) {
    return runExclusive(`${cand.entityType}:${cand.id}`, () => {
      const row = this.store.get(cand.entityType, cand.id);
      if (!row) return false;
      const now = Date.now();

      if (cand.kind === 'corrupt_row') this.store.moveToLostAndFound(cand.entityType, row, `corrupt:${cand.evidence.fields}`);

      // 劣质技能：先 FROZEN 观察 7 天（不直接隔离，§6.2.3；状态机：ACTIVE→COOLING→FROZEN）
      if (cand.kind === 'low_quality_skill') {
        if (row.state === 'ACTIVE' || row.state === 'COOLING') {
          if (row.state === 'ACTIVE') this.store.transition('skill', cand.id, 'COOLING');
          this.store.transition('skill', cand.id, 'FROZEN', { frozen_at: now });
          this.store.logPurge({
            epoch, entityType: 'skill', entityId: cand.id, action: 'FREEZE', dimension: 'skill',
            reason: `kind=low_quality_skill`, evidence: { ...cand.evidence, observe_days: CONFIG.SKILL_FROZEN_OBSERVE_DAYS },
            confidence: 0.85, snapshotId, status: 'DONE',
          });
          return true;
        }
        return false;
      }

      // 状态链合法化（§3.3）
      if (cand.entityType === 'memory' && cand.kind === 'expired' && row.state === 'ACTIVE') {
        this.store.transition('memory', cand.id, 'EXPIRED');
      }
      if (cand.entityType === 'experience' && row.state === 'ACTIVE' && cand.kind === 'stale') {
        this.store.transition('experience', cand.id, 'DEPRECATED');
      }
      if (cand.entityType === 'skill' && row.state === 'DRAFT') {
        this.store.transition('skill', cand.id, 'REJECTED');
      }
      if (cand.entityType === 'skill' && row.state === 'FROZEN') {
        // FROZEN → QUARANTINED 走 settleFrozen，此处跳过
        return false;
      }

      const logId = this.store.logPurge({
        epoch, entityType: cand.entityType, entityId: cand.id,
        action: cand.kind === 'expired' ? 'EXPIRE' : cand.kind === 'corrupt_row' ? 'LOST_AND_FOUND' : 'QUARANTINE',
        dimension: cand.entityType === 'skill' ? 'skill' : cand.entityType,
        reason: `kind=${cand.kind}`,
        evidence: { ...cand.evidence, prev_state: row.state, prev_version: row.version, quality_score: row.quality_score },
        confidence: cand.rule ? 1.0 : 0.8,
        judgeMeta: null,
        snapshotId,
        status: 'EXECUTING',
      });
      try {
        this.store.transition(cand.entityType, cand.id, 'QUARANTINED', {
          quarantined_at: now,
          purge_after: now + CONFIG.QUARANTINE_TTL_DAYS * 86_400_000,
        });
        this.store.markPurgeDone(logId);
        // 净化清除质量分记账（净利率分子）
        this.store.setState('purify_removed_q', (this.store.getState('purify_removed_q', 0)) + (row.quality_score ?? 0));
        return true;
      } catch (e) {
        this.store.markPurgeRolledBack(logId);
        throw e;
      }
    });
  }

  // ═════════ FROZEN 观察期收尾（§6.2.3）═════════
  settleFrozen(now) {
    const out = { recovered: [], quarantined: [] };
    for (const s of this.store.list('skill', "WHERE state = 'FROZEN'")) {
      const days = (now - (s.frozen_at ?? s.updated_at)) / 86_400_000;
      const w = wilsonLowerBound(s.success_count, s.execution_count);
      if (w >= CONFIG.SKILL_DEMOTE_W && s.execution_count > 0) {
        // 观察期内被自然调用救回 → 回 ACTIVE
        this.store.transition('skill', s.id, 'ACTIVE');
        out.recovered.push(s.id);
      } else if (days >= CONFIG.SKILL_FROZEN_OBSERVE_DAYS) {
        // 仍无起色 → 隔离
        this.store.transition('skill', s.id, 'QUARANTINED', {
          quarantined_at: now, purge_after: now + CONFIG.QUARANTINE_TTL_DAYS * 86_400_000,
        });
        this.store.logPurge({
          epoch: this.store.epoch, entityType: 'skill', entityId: s.id, action: 'QUARANTINE', dimension: 'skill',
          reason: 'frozen_observe_timeout', evidence: { frozen_days: Math.round(days), wilson: Number(w.toFixed(3)) },
          confidence: 0.9, snapshotId: null, status: 'DONE',
        });
        this.store.setState('purify_removed_q', (this.store.getState('purify_removed_q', 0)) + (s.quality_score ?? 0));
        out.quarantined.push(s.id);
      }
    }
    return out;
  }

  // ═════════ ⑥ REVIEW 复审抽样（翻案率=净化精确率的直接度量，§6.1-⑥）═════════
  async reviewSampled({ label, ids = null } = {}) {
    const store = this.store;
    const quarantined = store.list('memory', "WHERE state = 'QUARANTINED'")
      .concat(store.list('experience', "WHERE state = 'QUARANTINED'"))
      .concat(store.list('skill', "WHERE state = 'QUARANTINED'"));
    const sample = ids
      ? quarantined.filter((q) => ids.includes(q.id))
      : quarantined.filter(() => Math.random() < Math.max(CONFIG.REVIEW_SAMPLE_RATIO, 1 / Math.max(quarantined.length, 1))).slice(0, 3);
    const result = { sampled: sample.length, overturned: [], confirmed: [] };

    for (const row of sample) {
      const log = store.db.prepare(
        "SELECT * FROM purge_logs WHERE entity_id = ? AND action IN ('QUARANTINE','EXPIRE','LOST_AND_FOUND','FREEZE') AND status = 'DONE' ORDER BY created_at DESC LIMIT 1"
      ).get(row.id);
      const reason = log?.reason ?? 'unknown';
      const evidence = JSON.parse(log?.evidence ?? '{}');

      // 客观复核：原判定与证据是否自洽（例：low_quality 但 n<5 → 误判，翻案）
      let overturn = false;
      if (reason.includes('low_quality')) {
        const n = row.execution_count ?? row.access_count ?? row.sample_count ?? 0;
        if (n < CONFIG.MIN_EVIDENCE_N) overturn = true;
      }
      // LLM 复核（双采样一致才翻案；弃权维持原判）
      if (!overturn && labelBudgetLeft(label, CONFIG.PURIFY_CYCLE_TOKEN_BUDGET) > 0 && !budgetExhausted()) {
        const digest = (row.content ?? row.summary ?? row.description ?? row.name ?? '').slice(0, 80);
        const j = await judge({
          system: '你是净化复审员。判断当初隔离该实体是否正当。',
          question: `实体摘要：「${digest}」\n隔离理由：${reason}（证据：${JSON.stringify(evidence).slice(0, 150)}）\n若理由与证据充分且自洽则 JUSTIFIED，若证据不足或矛盾则 UNJUSTIFIED。`,
          options: ['JUSTIFIED', 'UNJUSTIFIED'],
          label,
        });
        if (!j.abstain && j.verdict === 'UNJUSTIFIED') overturn = true;
      }

      if (overturn) {
        this.restore(row.id);
        result.overturned.push(row.id);
        store.logPurge({ epoch: store.epoch, entityType: log?.entity_type ?? 'memory', entityId: row.id, action: 'REVIEW_OVERTURN', dimension: 'review', reason: `复审翻案：${reason}`, evidence: { original_reason: reason }, confidence: 0.9, snapshotId: null, status: 'DONE' });
      } else {
        result.confirmed.push(row.id);
        store.logPurge({ epoch: store.epoch, entityType: log?.entity_type ?? 'memory', entityId: row.id, action: 'REVIEW_OK', dimension: 'review', reason: '复审维持', evidence: {}, confidence: 1, snapshotId: null, status: 'DONE' });
      }
    }
    // 翻案率滚动记录（进入观测指标）
    const hist = store.getState('review_history', { sampled: 0, overturned: 0 });
    store.setState('review_history', { sampled: hist.sampled + result.sampled, overturned: hist.overturned + result.overturned.length });
    return result;
  }

  // ═════════ 反振荡：对抗计数（血缘链 ≥3 次生成-被净化 → 冻结整链，§6.5-4）═════════
  checkAdversarial() {
    const store = this.store;
    const frozen = [];
    // 找 QUARANTINED/REJECTED 实体的血缘根，统计同链被净化次数
    const chainPurgedCount = new Map(); // rootId -> count
    const rootOf = new Map();
    const all = [];
    for (const t of ['memory', 'experience', 'skill']) {
      all.push(...store.list(t, '').map((r) => ({ type: t, row: r })));
    }
    const findRoot = (type, id, depth = 0) => {
      if (depth > 10) return id;
      const row = all.find((x) => x.row.id === id)?.row;
      if (!row?.parent_id) return id;
      return findRoot(type, row.parent_id, depth + 1);
    };
    for (const { type, row } of all) {
      if (['QUARANTINED', 'REJECTED', 'PURGED'].includes(row.state)) {
        const root = findRoot(type, row.id);
        rootOf.set(row.id, root);
        chainPurgedCount.set(root, (chainPurgedCount.get(root) ?? 0) + 1);
      }
    }
    for (const [root, count] of chainPurgedCount) {
      if (count >= CONFIG.ADVERSARIAL_FREEZE) {
        // 冻结同链所有活跃实体（冻结比删除更安全，进入策略净化复盘）
        for (const { type, row } of all) {
          if (findRoot(type, row.id) === root && ['ACTIVE', 'DRAFT', 'COOLING'].includes(row.state)) {
            try {
              if (type === 'skill') {
                if (row.state === 'DRAFT') this.store.transition('skill', row.id, 'REJECTED');
                this.store.transition('skill', row.id, 'QUARANTINED', { quarantined_at: Date.now(), purge_after: Date.now() + CONFIG.QUARANTINE_TTL_DAYS * 86_400_000 });
              } else {
                this.store.transition(type, row.id, 'QUARANTINED', { quarantined_at: Date.now(), purge_after: Date.now() + CONFIG.QUARANTINE_TTL_DAYS * 86_400_000 });
              }
              frozen.push(`${type}:${row.id}`);
              store.logPurge({ epoch: store.epoch, entityType: type, entityId: row.id, action: 'QUARANTINE', dimension: 'risk', reason: `adversarial_freeze（血缘链 ${count} 次生成-被净化）`, evidence: { root, count }, confidence: 1, snapshotId: null, status: 'DONE' });
            } catch { /* 状态非法则跳过 */ }
          }
        }
        store.setState(`lineage_frozen:${root}`, { count, at: Date.now() });
      }
    }
    return frozen;
  }

  // ═════════ 风险净化：净利率破线 → 回滚最近快照（§6.2.6）═════════
  async riskGuard(netRateValue) {
    const store = this.store;
    const hist = store.getState('net_rate_history', []);
    const recent = hist.slice(-3);
    const bad = recent.length === 3 && recent.every((x) => x < CONFIG.NET_RATE_ROLLBACK_LINE);
    if (!bad) return { action: 'none' };
    const snap = store.snapshots()[0];
    if (!snap) return { action: 'none', note: 'no_snapshot' };
    store.setState('pending_rollback', { snapshot: snap.file, netRate: netRateValue, at: Date.now() });
    return { action: 'rollback_proposed', snapshot: snap.file };
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

  // ═════════ 隔离区恢复（回滚，§6.3-5）═════════
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

  // ═════════ 崩溃恢复（§7.2）═════════
  recoverInterrupted() {
    const rows = this.store.executingPurges();
    const fixed = [];
    for (const log of rows) {
      const entity = this.store.get(log.entity_type, log.entity_id);
      if (entity && entity.state === 'QUARANTINED') {
        this.store.markPurgeDone(log.id);
        fixed.push(`${log.entity_id}: done`);
      } else {
        this.store.markPurgeRolledBack(log.id);
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

  /** 净利率记录 + 稳态断言（§1.4/§6.5-5/§12.2） */
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
    if (history.slice(-3).every((x) => Math.abs(x) > CONFIG.NET_RATE_INSTABILITY)) {
      store.setState('instability_event', { at: Date.now(), history: history.slice(-3) });
    }
    store.setState('evolve_added_q', 0);
    store.setState('purify_removed_q', 0);
    return Number(nr.toFixed(4));
  }

  isDegraded() { return budgetExhausted(); }
}
