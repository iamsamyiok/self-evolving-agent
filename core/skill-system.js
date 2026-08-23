// core/skill-system.js —— 技能自进化（§5.1）：提炼 → DRAFT → 黄金集验证门禁 → ACTIVE → 热度分级
// 铁律：技能生成即上线被禁止（附录 B-6）；版本对决必须基于真实执行证据（§5.1.3）。
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { BM25Index, jaccard, tokenize } from '../utils/similarity.js';
import { qualityScore, hysteresis, wilsonLowerBound, recencyScore } from '../utils/stats.js';
import { chatJson } from './llm-adapter.js';

export class SkillSystem {
  constructor(store = new Store(), executor = null) {
    this.store = store;
    this.executor = executor; // 延迟注入，避免循环依赖（agent-executor 需要 SkillSystem）
  }

  active() { return this.store.list('skill', "WHERE state IN ('ACTIVE','COOLING')"); }
  drafts() { return this.store.list('skill', "WHERE state = 'DRAFT'"); }

  /** 任务成功后提炼技能候选（冷启动：技能池为空属正常态，§5.1.5） */
  async distillFromTrace(trace) {
    if (trace.outcome !== 'SUCCESS' || !trace?.input) return null;
    const prompt = [
      { role: 'system', content: '你是技能提炼器。判断该任务是否有可复用的成套做法。若有，输出 JSON：{"name":"snake_case名","scenario":"适用场景","description":"功能说明","steps":[{"goal":"...","action":"reason|answer","expected":"..."}]}；没有则输出 {"name":null}。' },
      { role: 'user', content: `任务：${trace.input}\n执行步骤：${JSON.stringify((trace.steps ?? []).map((s) => s.goal ?? s).slice(0, 8))}\n回答摘要：${(trace.answer ?? '').slice(0, 300)}` },
    ];
    const out = await chatJson({
      messages: prompt,
      validate: (v) => (v?.name == null ? null
        : typeof v.name !== 'string' || !/^[a-z][a-z0-9_]{2,40}$/.test(v.name) ? 'name 须为 snake_case'
        : !Array.isArray(v.steps) || v.steps.length < 1 ? 'steps 须为非空数组' : null),
      label: 'skill-distill',
    });
    if (!out?.name) return null;

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
      const band = hysteresis(q, { promote: CONFIG.SKILL_PROMOTE_W, demote: CONFIG.SKILL_DEMOTE_W, purge: CONFIG.SKILL_PURGE_W });
      if (n >= 5 && w >= CONFIG.SKILL_PROMOTE_W && this.hitsInDays(skillId, 7) >= 5) fields.heat = 'hot';
      else if (band === 'demote') { this.store.update('skill', skillId, fields); this.store.transition('skill', skillId, 'COOLING'); return; }
      else if (s.heat === 'hot' && this.hitsInDays(skillId, 7) < 5) fields.heat = 'warm';
    } else if (s.state === 'COOLING') {
      const band = hysteresis(q, { promote: CONFIG.SKILL_PROMOTE_W, demote: CONFIG.SKILL_DEMOTE_W, purge: CONFIG.SKILL_PURGE_W });
      if (band === 'promote') { this.store.update('skill', skillId, fields); this.store.transition('skill', skillId, 'ACTIVE'); return; }
    }
    this.store.update('skill', skillId, fields);
  }

  hitsInDays(skillId, days) {
    // MVP：无逐次命中日志，按创建以来均速估算（n 天内估计命中数）
    const s = this.store.get('skill', skillId);
    if (!s || !s.execution_count) return 0;
    const ageDays = Math.max(0.5, (Date.now() - s.created_at) / 86_400_000);
    const ratePerDay = s.execution_count / ageDays;
    return Math.round(ratePerDay * days);
  }

  /** 检索：供 L6 上下文装配 */
  retrieve(query, topK = CONFIG.RETRIEVAL_TOP_K) {
    const actives = this.active().filter((s) => s.heat !== 'cold');
    if (!actives.length) return [];
    const idx = new BM25Index(actives.map((s) => ({ id: s.id, text: `${s.name} ${s.scenario} ${s.description}` })));
    const hits = idx.search(query, topK);
    const now = Date.now();
    return hits.map((h) => {
      const row = actives.find((s) => s.id === h.id);
      const rec = Math.exp(-((now - (row.last_used_at ?? row.created_at)) / 86_400_000) / 14);
      return { row, score: 0.6 * h.score + 0.25 * row.quality_score + 0.15 * (Number.isFinite(rec) ? rec : 0) };
    }).filter((x) => x.score > 0.1);
  }
}
