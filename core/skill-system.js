// core/skill-system.js —— 技能自进化（§5.1）：提炼 → DRAFT → 黄金集验证门禁 → ACTIVE → 热度分级
// 铁律：技能生成即上线被禁止（附录 B-6）；版本对决必须基于真实执行证据（§5.1.3）。
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { BM25Index, jaccard, tokenize } from '../utils/similarity.js';
import { qualityScore, hysteresis, wilsonLowerBound, recencyScore } from '../utils/stats.js';
import { chatJson, embed } from './llm-adapter.js';
import { backfillOne } from './embed-backfill.js';
import { EntityIndex } from './retrieval-cache.js';

export class SkillSystem {
  constructor(store = new Store(), executor = null) {
    this.store = store;
    this.executor = executor; // 延迟注入，避免循环依赖（agent-executor 需要 SkillSystem）
    this.idx = new EntityIndex(store, 'skill', (s) => `${s.name} ${s.scenario} ${s.description}`, {
      where: "WHERE state IN ('ACTIVE','COOLING')",
    });
  }

  active() { return [...this.idx.rows.values()]; }
  drafts() { return this.store.list('skill', "WHERE state = 'DRAFT'"); }

  /** 任务成功后提炼技能候选（冷启动：技能池为空属正常态，§5.1.5） */
  async distillFromTrace(trace) {
    if (!trace?.input) return null;
    // 失败任务也提炼（失败模式可复用）
    // 工具白名单与运行时注册表同源（含 news_search 等），蒸馏出的技能步骤才不会固化不存在的工具用法
    const registry = this.executor?.tools?.tools;
    const toolList = registry ? [...registry.keys()].filter((n) => n !== 'shell').join(' | ') : 'news_search';
    const prompt = [
      { role: 'system', content: `你是技能提炼器。判断该任务是否有可复用的成套做法。若有，输出 JSON：{"name":"snake_case名","scenario":"适用场景","description":"功能说明","steps":[{"goal":"...","action":"reason|answer|tool:<下列工具名之一>","params":{},"expected":"..."}]}；没有则输出 {"name":null}。\n可用工具：${toolList}\n规则：搜索/新闻/实时信息类步骤必须用 tool:news_search（参数 query）；http_get 仅用于完整 URL 的公开 API 调用；禁止使用清单外的工具名。` },
      { role: 'user', content: `任务：${trace.input}\n结果：${trace.outcome}\n执行步骤：${JSON.stringify((trace.steps ?? []).map((s) => ({ goal: s.goal, output: (s.output || '').slice(0, 100) })).slice(0, 8))}\n${trace.error ? '错误：' + trace.error.slice(0, 200) : ''}\n回答摘要：${(trace.answer ?? '').slice(0, 300)}` },
    ];
    const out = await chatJson({
      messages: prompt,
      validate: (v) => (v?.name == null ? null
        : typeof v.name !== 'string' || !/^[a-z][a-z0-9_]{2,40}$/.test(v.name) ? 'name 须为 snake_case'
        : !Array.isArray(v.steps) || v.steps.length < 1 ? 'steps 须为非空数组'
        : !v.steps.every((s) => {
            if (s?.action === 'reason' || s?.action === 'answer') return true;
            if (!s.action?.startsWith('tool:') || !s.params) return false;
            const toolName = s.action.slice(5);
            const knownTools = registry ? [...registry.keys()].filter((n) => n !== 'shell') : ['news_search'];
            if (!knownTools.includes(toolName)) return false;
            if (toolName === 'news_search' && !s.params.query) return false;
            if (toolName === 'http_get' && !s.params.url) return false;
            if (toolName === 'run_js' && !s.params.code) return false;
            return true;
          }) ? '步骤含不可执行 tool: 动作或缺少必填参数' : null),
      label: 'skill-distill',
    });
    if (!out?.name) return null;

    // 蒸馏治愈：LLM 仍可能产出 http_get+query（无 url）的坏步骤——改道 news_search，防止失败用法固化进技能
    for (const s of out.steps) {
      if (s?.action === 'tool:http_get' && s.params && !s.params.url) {
        const q = s.params.query ?? s.params.keyword ?? s.params.search_query ?? s.params.q ?? s.params.topic;
        if (q) { s.action = 'tool:news_search'; s.params = { query: String(q), maxResults: s.params.max_results ?? 8 }; }
      }
    }

    // 墓碑检查：与被硬清除内容高度相似 → 禁止直接再生（§6.5-3，反振荡）
    const tombHit = this.checkTombstones(`${out.name} ${out.scenario} ${out.description}`);
    if (tombHit) {
      this.store.logPurge({ epoch: this.store.epoch, entityType: 'skill', entityId: 'new', action: 'DEDUP_SKIP', dimension: 'skill', reason: `命中墓碑（相似度 ${tombHit.toFixed(2)}），禁止被净化内容立即复活`, evidence: { name: out.name }, status: 'DONE' });
      return null;
    }

    // 场景重复检查：已有同场景技能 → 不重复生成
    const dup = this.findSimilar(out.scenario);
    if (dup) return { status: 'dup', id: dup.id };

    const id = uuid7();
    const now = Date.now();
    await runExclusive(`skill:${id}`, () => {
      this.store.insert('skill', {
        id, state: 'DRAFT', version: 1, parent_id: null, origin: 'evolve',
        created_at: now, updated_at: now, immunity_until: now + CONFIG.IMMUNITY_HOURS * 3600_000,
        execution_count: 0, quality_score: 0.5, embedding: null,
        quarantined_at: null, purge_after: null, last_used_at: null,
        name: out.name, scenario: out.scenario.slice(0, 200), description: out.description.slice(0, 300),
        steps: JSON.stringify(out.steps.slice(0, 8)),
        params_schema: null, success_count: 0, fail_count: 0, verified: 0, heat: 'warm',
      });
    });
    backfillOne(this.store, 'skill', id); // 异步补语义向量
    return { status: 'draft', id };
  }

  checkTombstones(text) {
    const tombs = this.store.tombstones();
    if (!tombs.length) return 0;
    const tokA = tokenize(text);
    for (const t of tombs) {
      if (jaccard(tokA, JSON.parse(t.tokens)) >= 0.90) return 0.90;
    }
    return 0;
  }

  findSimilar(scenario) {
    const actives = this.active();
    if (!actives.length) return null;
    const idx = new BM25Index(actives.map((s) => ({ id: s.id, text: `${s.name} ${s.scenario} ${s.description}` })));
    const tokA = tokenize(scenario);
    for (const h of idx.search(scenario, 3)) {
      const row = actives.find((s) => s.id === h.id);
      const sig = `${row.name} ${row.scenario} ${row.description}`;
      if (jaccard(tokA, tokenize(sig)) >= CONFIG.SKILL_DUP_JACCARD) return row;
    }
    return null;
  }

  /**
   * 验证门禁（§5.1.4）：DRAFT → ACTIVE 必须在黄金集相关子集（≥3 条）上跑赢/不劣于基线。
   * 门禁不通过 3 次 → REJECTED → 隔离区。
   */
  async verifyDraft(skillId) {
    const s = this.store.get('skill', skillId);
    if (!s || s.state !== 'DRAFT') return { status: 'not_draft' };
    if (!this.executor) return { status: 'no_executor' };

    const golden = this.store.db.prepare('SELECT * FROM golden_tasks WHERE enabled = 1').all()
      .map((g) => ({ ...g, assertion: JSON.parse(g.assertion) }));
    const matched = new BM25Index(golden.map((g) => ({ id: g.id, text: g.input }))).search(s.scenario, 3);
    if (matched.length < 3) return { status: 'insufficient_golden', matched: matched.length };

    let pass = 0;
    for (const m of matched) {
      const g = golden.find((x) => x.id === m.id);
      const r = await this.executor.runTask(g.input, { assertion: g.assertion, skillOverride: s, silent: true });
      if (r.outcome === 'SUCCESS') pass++;
    }
    const rate = pass / matched.length;
    this.store.update('skill', skillId, { verified: 0 });
    if (rate >= 2 / matched.length) { // ≥ 2/3 通过即晋升门禁线（MVP 基线：无技能基线约为同水平）
      const row = this.store.get('skill', skillId);
      this.store.transition('skill', skillId, 'ACTIVE', { verified: 1 });
      this.snapshotSkill(skillId, 'promoted_baseline'); // 晋升时刻快照 = 已验证起点版本（后续污染回滚锚点）
      return { status: 'promoted', rate };
    }
    const attempts = (this.store.getState(`skill_gate_attempts:${skillId}`, 0)) + 1;
    this.store.setState(`skill_gate_attempts:${skillId}`, attempts);
    if (attempts >= 3) {
      this.store.transition('skill', skillId, 'REJECTED');
      this.store.transition('skill', skillId, 'QUARANTINED', { quarantined_at: Date.now(), purge_after: Date.now() + CONFIG.QUARANTINE_TTL_DAYS * 86_400_000 });
      return { status: 'rejected', attempts };
    }
    return { status: 'gate_failed', attempts, rate };
  }

  /** 执行结果记账 + Q 重算 + 热度/迟滞迁移（每次任务后调用，零 LLM 成本，§5.1.3） */
  recordExecution(skillId, ok) {
    const s = this.store.get('skill', skillId);
    if (!s) return;
    const success = s.success_count + (ok ? 1 : 0);
    const fail = s.fail_count + (ok ? 0 : 1);
    const n = s.execution_count + 1;
    const q = qualityScore({ successCount: success, failCount: fail, executionCount: n, lastUsedAt: Date.now() });
    const fields = { success_count: success, fail_count: fail, execution_count: n, quality_score: q, last_used_at: Date.now() };

    // 热度：7 天内命中 ≥5 次且 W ≥ 晋升线 → hot（量化定义 §5.1.2）
    const w = wilsonLowerBound(success, n);
    if (s.state === 'ACTIVE') {
      // 快速熔断：连续 2 次失败立即 COOLING（不等 Wilson 收敛——坏技能每多跑一次都是浪费的 LLM 调用）
      const streakField = { fail_streak: ok ? 0 : (s.fail_streak ?? 0) + 1 };
      if (!ok && streakField.fail_streak >= 2) {
        this.snapshotSkill(skillId, 'streak_cooling'); // 熔断前留存证据快照
        // 污染回滚：若存在质量显著更优的历史版本（ΔQ≥0.15），恢复其内容并重置计数，替代 COOLING
        if (this.tryRollback(skillId)) return;
        this.store.bumpStats('skill', skillId, { ...fields, ...streakField });
        this.store.transition('skill', skillId, 'COOLING');
        this.store.logPurge({ epoch: this.store.epoch, entityType: 'skill', entityId: skillId, action: 'STREAK_COOLING', dimension: 'quality', reason: '连续 2 次执行失败，快速熔断进 COOLING（防坏技能持续浪费调用）', evidence: { fail_streak: streakField.fail_streak }, status: 'DONE' });
        return;
      }
      const band = hysteresis(q, { promote: CONFIG.SKILL_PROMOTE_W, demote: CONFIG.SKILL_DEMOTE_W, purge: CONFIG.SKILL_PURGE_W });
      if (n >= 5 && w >= CONFIG.SKILL_PROMOTE_W && this.hitsInDays(skillId, 7) >= 5) fields.heat = 'hot';
      else if (band === 'demote') { this.store.bumpStats('skill', skillId, { ...fields, ...streakField }); this.store.transition('skill', skillId, 'COOLING'); return; }
      else if (s.heat === 'hot' && this.hitsInDays(skillId, 7) < 5) fields.heat = 'warm';
      this.store.bumpStats('skill', skillId, { ...fields, ...streakField });
      return;
    } else if (s.state === 'COOLING') {
      const band = hysteresis(q, { promote: CONFIG.SKILL_PROMOTE_W, demote: CONFIG.SKILL_DEMOTE_W, purge: CONFIG.SKILL_PURGE_W });
      if (band === 'promote') { this.store.bumpStats('skill', skillId, fields); this.store.transition('skill', skillId, 'ACTIVE'); return; }
    }
    // Step7：低成功率兜底 —— 即使尚未积累到 N≥5，若失败占比≥50% 且失败次数≥3，强制 COOLING
    // 防止新技能在早期少量调用中被误判为"潜力股"而继续消耗
    if (n >= 3 && fail >= 3 && fail / n >= 0.5) {
      this.snapshotSkill(skillId, 'low_success_rate_cooling');
      this.store.bumpStats('skill', skillId, fields);
      if (s.state !== 'COOLING') {
        this.store.transition('skill', skillId, 'COOLING');
        this.store.logPurge({ epoch: this.store.epoch, entityType: 'skill', entityId: skillId, action: 'LOW_SUCCESS_COOLING', dimension: 'quality', reason: `低成功率强制冷却（${fail}/${n} 失败，失败率 ${(fail/n*100).toFixed(0)}%）`, evidence: { fail_count: fail, total: n, rate: Number((fail/n).toFixed(2)) }, status: 'DONE' });
      }
      return;
    }
    // 统计记账走 bumpStats 直写：每次任务后的执行记账不触发检索索引重建
    this.store.bumpStats('skill', skillId, fields);
  }

  hitsInDays(skillId, days) {
    // MVP：无逐次命中日志，按创建以来均速估算（n 天内估计命中数）
    const s = this.store.get('skill', skillId);
    if (!s || !s.execution_count) return 0;
    const ageDays = Math.max(0.5, (Date.now() - s.created_at) / 86_400_000);
    const ratePerDay = s.execution_count / ageDays;
    return Math.round(ratePerDay * days);
  }

  /** 版本快照：状态转换前留存内容证据（污染回滚的依据源） */
  snapshotSkill(skillId, reason) {
    const s = this.store.get('skill', skillId);
    if (!s) return null;
    try {
      this.store.db.prepare(
        `INSERT INTO skill_versions (id, skill_id, version, name, scenario, description, steps, quality_score, success_count, fail_count, snapshot_at, reason, sha)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(uuid7(), skillId, s.version ?? 1, s.name, s.scenario, s.description, s.steps,
        s.quality_score ?? 0.5, s.success_count ?? 0, s.fail_count ?? 0, Date.now(), String(reason ?? '').slice(0, 120), null);
    } catch { /* 快照失败不阻塞主流程 */ }
    return true;
  }

  /** 污染回滚：存在质量显著更优的历史版本（ΔQ ≥ 0.15 且历史 Q ≥ 0.5）则恢复内容并重置计数。
   *  返回回滚到的版本号，无可回滚返回 0。回滚后回 ACTIVE 以干净证据重新积累。 */
  tryRollback(skillId) {
    const s = this.store.get('skill', skillId);
    if (!s) return 0;
    let snaps;
    try { snaps = this.store.db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY quality_score DESC').all(skillId); }
    catch { return 0; } // 旧库无表
    const best = snaps.find((v) => (v.quality_score ?? 0) - (s.quality_score ?? 0) >= 0.15 && (v.quality_score ?? 0) >= 0.5);
    if (!best) return 0;
    this.store.db.prepare(
      `UPDATE skills SET name = ?, scenario = ?, description = ?, steps = ?, quality_score = 0.5,
        success_count = 0, fail_count = 0, execution_count = 0, fail_streak = 0, verified = 1, updated_at = ? WHERE id = ?`
    ).run(best.name, best.scenario, best.description, best.steps, Date.now(), skillId);
    if (s.state !== 'ACTIVE') this.store.transition('skill', skillId, 'ACTIVE', { rolled_back_to: best.version }); // 回滚后以干净证据重新积累（本就 ACTIVE 则无需迁移）
    const snapshotRow = this.store.db.prepare('SELECT sha FROM skill_versions WHERE skill_id = ? AND version = ?').get(skillId, best.version);
    this.store.logPurge({ epoch: this.store.epoch, entityType: 'skill', entityId: skillId, action: 'ROLLBACK', dimension: 'quality', reason: `连续失败触发污染回滚：恢复历史版本 v${best.version}（Q ${best.quality_score.toFixed(2)} > 当前 ${((s.quality_score ?? 0)).toFixed(2)}），计数重置`, evidence: { restored_version: best.version, restored_q: best.quality_score, prev_q: s.quality_score, snapshot_sha: snapshotRow?.sha ?? null, rollback_reason: 'fail_streak' }, status: 'DONE' });
    return best.version;
  }

  /** 手动回滚（dashboard/API）：指定技能恢复到质量最优历史版本，回滚后触发验证闭环 */
  async rollbackManually(skillId) {
    const s = this.store.get('skill', skillId);
    if (!s) return { ok: false, reason: 'not_found' };
    this.snapshotSkill(skillId, 'manual_rollback');
    const v = this.tryRollback(skillId);
    if (!v) return { ok: false, reason: 'no_better_snapshot' };
    // 验证闭环：回滚后以 ACTIVE 身份跑一次验证，确认恢复版本可用（防回滚到另一坏版本）
    try {
      const verification = await this.verifyDraft(skillId);
      return { ok: true, restored_version: v, verified: verification.status === 'promoted' };
    } catch {
      return { ok: true, restored_version: v, verified: false, verify_error: 'rollback verification failed' };
    }
  }

  /** 版本历史查询（dashboard 用） */
  versions(skillId) {
    try { return this.store.db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY snapshot_at DESC LIMIT 50').all(skillId); }
    catch { return []; }
  }

  /** 检索：供 L6 上下文装配（权重可调参，默认 §3.4-4）；走缓存索引，cold 热度条目过滤 */
  async retrieve(query, topK = CONFIG.RETRIEVAL_TOP_K, weights = { sim: 0.6, quality: 0.25, recency: 0.15 }) {
    const qv = await embed(query).catch(() => null);
    const hits = this.idx.hybridSearch(query, topK * 2, qv); // 混合分归一化 [0,1]
    const now = Date.now();
    const out = [];
    for (const h of hits) {
      const row = this.idx.rows.get(h.id);
      if (!row || row.heat === 'cold') continue;
      const rec = Math.exp(-((now - (row.last_used_at ?? row.created_at)) / 86_400_000) / 14);
      const score = weights.sim * h.score + weights.quality * row.quality_score + weights.recency * (Number.isFinite(rec) ? rec : 0);
      if (score > 0.15) out.push({ row, score }); // 归一化尺度下 0.15 ≈ 弱语义命中下限
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }
}
