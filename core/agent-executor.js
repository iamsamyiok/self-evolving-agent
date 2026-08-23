// core/agent-executor.js —— L6 执行内核（§5.4）：上下文装配（先预算后填充）→ 规划 → 分步执行（含工具/红线）→ 判定 → 轨迹落库
// v0.2：任务预算 L1 熔断、Prompt 版本化（策略净化地基）、检索权重可调参、工具步骤执行
import { createHash } from 'node:crypto';
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { MemorySystem } from './memory-system.js';
import { ExperienceEngine, traceHash } from './experience-engine.js';
import { SkillSystem } from './skill-system.js';
import { ToolRuntime } from './tool-runtime.js';
import { chat, chatJson, judge, budgetExhausted, labelBudgetLeft, getUsage } from './llm-adapter.js';
import { assembleWithinBudget } from '../utils/token-utils.js';
import { checkStep } from './safety-constitution.js';

export const DEFAULT_PROMPTS = {
  planner: '你是任务规划器。把任务拆成 2-4 个可执行步骤。输出 JSON：{"steps":[{"goal":"...","action":"reason|answer|tool:<名>","params":{}}]}',
  step: '你是任务执行者，按步骤推进。',
  final: '你是任务执行者。基于全部步骤输出最终回答（简洁、直接给结果）。',
};

export class AgentExecutor {
  constructor(store = new Store()) {
    this.store = store;
    this.memory = new MemorySystem(store);
    this.experience = new ExperienceEngine(store);
    this.skills = new SkillSystem(store, this);
    this.tools = new ToolRuntime();
    this.evolveHooks = true;
    this.onTaskDone = null;
    this._evolveTail = null;
    this.initPrompts();
  }

  /** Prompt 注册表初始化：首次运行写入 v1 为 active（策略净化 §6.2.5 的版本化地基） */
  initPrompts() {
    for (const [role, content] of Object.entries(DEFAULT_PROMPTS)) {
      if (!this.store.activePrompt(role)) {
        this.store.insertPrompt({
          id: uuid7(), role, version: 1, content,
          sha256: createHash('sha256').update(content).digest('hex'),
          status: 'active',
        });
      }
    }
  }

  prompt(role) {
    return this.store.activePrompt(role)?.content ?? DEFAULT_PROMPTS[role];
  }

  /** 当前生效的检索权重（自动调参写 system_state，界内可回退，§6.2.5） */
  retrievalWeights() {
    return this.store.getState('tuned_retrieval', { sim: CONFIG.W_SIM_DEFAULT ?? 0.6, quality: 0.25, recency: 0.15 });
  }

  /** 上下文装配（§5.4 固定顺序；先预算后填充，各类保底 1 条）。返回 {text, used}，used 供前端展示「本次用了什么」 */
  assembleContext(taskInput, skillOverride = null) {
    const w = this.retrievalWeights();
    const used = { skills: [], memories: [], experiences: [] };
    const skills = skillOverride
      ? [{ id: skillOverride.id, text: `技能「${skillOverride.name}」：${skillOverride.description} 步骤：${skillOverride.steps}`, weight: 1 }]
      : this.skills.retrieve(taskInput, undefined, w).map((r) => {
          used.skills.push({ id: r.row.id, name: r.row.name, q: Number(r.row.quality_score.toFixed(2)) });
          return { id: r.row.id, text: `技能「${r.row.name}」：${r.row.description}`, weight: r.score };
        });
    const memories = this.memory.retrieve(taskInput, undefined, w).map((r) => {
      used.memories.push({ id: r.row.id, excerpt: r.row.content.slice(0, 40), q: Number(r.row.quality_score.toFixed(2)) });
      return { id: r.row.id, text: r.row.content, weight: r.score };
    });
    const experiences = this.experience.retrieve(taskInput, undefined, w).map((r) => {
      used.experiences.push({ id: r.row.id, summary: r.row.summary.slice(0, 40), q: Number(r.row.quality_score.toFixed(2)) });
      return {
        id: r.row.id,
        text: `经验：${r.row.summary}；规则：${(JSON.parse(r.row.rules || '[]')).join('；')}`,
        weight: r.score,
      };
    });
    const assembled = assembleWithinBudget(
      [
        { name: '技能', items: skills },
        { name: '记忆', items: memories },
        { name: '经验', items: experiences },
      ],
      Math.floor(CONFIG.MAX_CONTEXT_TOKEN * 0.6)
    );
    const text = assembled
      .filter((s) => s.items.length)
      .map((s) => `【${s.name}】\n${s.items.map((i) => `- ${i.text}`).join('\n')}`)
      .join('\n\n');
    return { text, used };
  }

  /** 执行单个任务。opts: { assertion, skillOverride, silent, goldenCheck, label, quick, onProgress } */
  async runTask(input, opts = {}) {
    const start = Date.now();
    const id = uuid7();
    const label = opts.label ?? `task:${id}`;
    const budgetWarn = budgetExhausted();
    const { text: context, used } = this.assembleContext(input, opts.skillOverride ?? null);
    const progress = (evt) => { try { opts.onProgress?.(evt); } catch { /* 进度回调失败不影响任务 */ } };

    let plan = null, steps = [], answer = null, error = null;
    try {
      if (opts.quick) {
        // 快速模式：单次直接回答（仍走判定+进化钩子，保持自进化信号）
        progress({ stage: 'answer', label: '快速回答' });
        const fin = await chat({
          messages: [
            { role: 'system', content: this.prompt('final') + (context ? `\n可用背景：\n${context}` : '') },
            { role: 'user', content: input },
          ], temperature: 0.3, label,
        });
        answer = fin.text?.trim();
        plan = { steps: [], quick: true };
      } else {
        for (let i = 0; i <= CONFIG.PLAN_RETRY_MAX && !plan; i++) {
          plan = await this.planOnce(input, context, label);
        }
        if (!plan) throw new Error('规划失败（LLM 弃权）');
        progress({ stage: 'plan', steps: plan.steps.map((s) => s.goal) });

        for (const [i, step] of plan.steps.entries()) {
          progress({ stage: 'step', idx: i + 1, total: plan.steps.length, goal: step.goal });
          // 每步前置红线检查（§6.2.6/§8.1：命中即拦截并记录风险事件）
          const rc = checkStep(step, { toolRuntime: this.tools, config: CONFIG });
          if (!rc.ok) {
            this.store.setState('last_risk_event', { at: Date.now(), task: id, step: step.goal, reason: rc.reason });
            throw new Error(`步骤「${step.goal}」触红线被拦截：${rc.reason}`);
          }
          let output = null, tries = 0;
          while (output == null && tries <= CONFIG.STEP_RETRY_MAX) {
            tries++;
            if (labelBudgetLeft(label, CONFIG.TASK_TOKEN_BUDGET) <= 0) {
              throw new Error('任务预算熔断（TASK_TOKEN_BUDGET 耗尽）');
            }
            output = await this.execStep(step, { input, steps, context, label });
          }
          if (output == null) throw new Error(`步骤「${step.goal}」连续失败`);
          steps.push({ goal: step.goal, action: step.action, output: String(output).slice(0, 500) });
        }

        progress({ stage: 'answer', label: '综合回答' });
        const fin = await chat({
          messages: [
            { role: 'system', content: this.prompt('final') },
            { role: 'user', content: `任务：${input}\n步骤结果：${JSON.stringify(steps)}\n最终回答：` },
          ], temperature: 0.2, label,
        });
        answer = fin.text?.trim();
      }
    } catch (e) {
      error = String(e?.message ?? e);
    }

    let outcome = 'FAIL', basis = 'error';
    if (!error) {
      const judged = this.checkAssertion(input, answer, opts.assertion);
      if (judged.__pendingJudge) {
        const j = await this.judgeOutcome(input, answer, label);
        outcome = j.outcome; basis = j.basis;
      } else {
        outcome = judged.outcome; basis = judged.basis;
      }
    }

    const duration = Date.now() - start;
    const trace = { id, input, plan, steps, answer, outcome, basis, error, duration_ms: duration, contextUsed: used };
    const u = getUsage(label);
    await runExclusive('task:write', () => {
      this.store.db.prepare(
        `INSERT INTO tasks (id, input, plan, steps, answer, outcome, outcome_basis, tokens_in, tokens_out, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, input, plan ? JSON.stringify(plan) : null, JSON.stringify(steps), answer, outcome, basis, u.tokensIn, u.tokensOut, error, duration, Date.now());
    });

    // 进化钩子（异步不阻塞；日预算 L3 触顶 → 降级为仅规则性沉淀）
    if (this.evolveHooks && !opts.goldenCheck) {
      this._evolveTail = (async () => {
        try {
          const degraded = budgetExhausted();
          await Promise.allSettled([
            degraded ? null : this.memory.extractFromTrace(trace),
            this.experience.retrospect(trace),
            degraded ? null : this.skills.distillFromTrace(trace).then((r) => r?.status === 'draft' && this.skills.verifyDraft(r.id)),
            this.goldenColdStart(trace),
          ]);
          if (context && outcome) this.chargeSkills(input, outcome === 'SUCCESS');
        } catch (e) {
          try { this.store.setState('last_evolve_error', String(e?.message ?? e)); } catch { /* 库已关闭则忽略 */ }
        } finally {
          this.onTaskDone?.(trace);
        }
      })();
    }

    if (!opts.silent) this.printTrace(trace, { budgetWarn });
    return trace;
  }

  /** 单步执行：tool:* 走沙箱运行时，其余走 LLM */
  async execStep(step, { input, steps, context, label }) {
    const action = String(step.action ?? 'reason');
    if (action.startsWith('tool:')) {
      const r = await this.tools.call(action.slice(5), step.params ?? {}, { taskId: label });
      return r.output;
    }
    const r = await chat({
      messages: [
        { role: 'system', content: `${this.prompt('step')}${context ? '可用背景：\n' + context : ''}` },
        { role: 'user', content: `任务：${input}\n当前步骤：${step.goal}\n已完成：${JSON.stringify(steps.map((s) => s.goal))}\n请输出本步骤结果（一段文字）。` },
      ], temperature: 0.3, label,
    });
    return r.text?.trim() || null;
  }

  planOnce(input, context, label = 'plan') {
    return chatJson({
      messages: [
        { role: 'system', content: this.prompt('planner') },
        { role: 'user', content: `${context ? '背景：\n' + context + '\n\n' : ''}任务：${input}` },
      ],
      validate: (v) => (!Array.isArray(v?.steps) || v.steps.length < 1 ? '须含非空 steps 数组'
        : v.steps.some((s) => typeof s?.goal !== 'string') ? '每个步骤须有 goal' : null),
      label,
    }).then((plan) => {
      if (!plan) return null;
      plan.steps = plan.steps.slice(0, 4).map((s) => ({
        goal: String(s.goal).slice(0, 120),
        action: /^tool:[a-z0-9_]+$/.test(String(s.action ?? '')) ? s.action : (s.action === 'answer' ? 'answer' : 'reason'),
        params: (s.params && typeof s.params === 'object') ? s.params : undefined,
      }));
      return plan;
    });
  }

  /** 断言判定：contains | regex | equals | judge（judge 走双采样） */
  checkAssertion(input, answer, assertion) {
    answer = answer ?? '';
    if (assertion?.type === 'contains') {
      return answer.includes(assertion.value) ? { outcome: 'SUCCESS', basis: 'assertion' } : { outcome: 'FAIL', basis: 'assertion' };
    }
    if (assertion?.type === 'regex') {
      try {
        return new RegExp(assertion.value).test(answer) ? { outcome: 'SUCCESS', basis: 'assertion' } : { outcome: 'FAIL', basis: 'assertion' };
      } catch { /* 坏正则按无断言处理 */ }
    }
    if (assertion?.type === 'equals') {
      return answer.trim() === String(assertion.value).trim() ? { outcome: 'SUCCESS', basis: 'assertion' } : { outcome: 'FAIL', basis: 'assertion' };
    }
    return { __pendingJudge: true, outcome: null, basis: null };
  }

  async judgeOutcome(input, answer, label = 'judge') {
    const r = await judge({
      system: '你是任务结果审查器，判断回答是否完成了任务要求。',
      question: `任务：「${input.slice(0, 200)}」\n回答：「${(answer ?? '').slice(0, 300)}」\n回答是否成功完成任务？`,
      options: ['SUCCESS', 'FAIL'],
      label,
    });
    if (r.abstain) return { outcome: 'FAIL', basis: 'judge_abstain' };
    return { outcome: r.verdict, basis: 'judge' };
  }

  /** 黄金集冷启动（§5.1.5 / §10.1） */
  async goldenColdStart(trace) {
    const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM golden_tasks').get().n;
    if (count >= CONFIG.GOLDEN_AUTO_MAX) return;
    if (trace.basis === 'judge_abstain' || !trace.answer) return;
    this.store.db.prepare('INSERT INTO golden_tasks (id, input, assertion, origin, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(uuid7(), trace.input, JSON.stringify({ type: 'judge', value: null }), 'cold-start', Date.now());
  }

  chargeSkills(input, ok) {
    for (const r of this.skills.retrieve(input, 3, this.retrievalWeights())) {
      this.skills.recordExecution(r.row.id, ok);
    }
  }

  /**
   * 黄金集回归门禁（§10.1）：跑相关子集+随机20%，与基线成功率回归 ≤ GOLDEN_REGRESSION_PP。
   * candidate: { apply(), revert() }（影子应用变更 → 跑门禁 → 通过则保留，否则回退）
   */
  async goldenGate({ candidate, subset = null, label = 'gate' }) {
    const golden = this.store.db.prepare('SELECT * FROM golden_tasks WHERE enabled = 1').all()
      .map((g) => ({ ...g, assertion: JSON.parse(g.assertion) }));
    if (!golden.length) {
      candidate.apply?.(); // 无黄金集可对照：视为无回归证据可拒，直接应用（保守系统可改为拒绝）
      return { pass: true, note: 'golden_empty_applied', ran: 0 };
    }
    const pool = subset ?? golden.filter(() => Math.random() < 0.2).concat(golden.slice(0, 3));
    const uniq = [...new Map(pool.map((g) => [g.id, g])).values()].slice(0, 8);

    const runBatch = async () => {
      let pass = 0;
      for (const g of uniq) {
        const t = await this.runTask(g.input, { assertion: g.assertion, silent: true, goldenCheck: true, label });
        if (t.outcome === 'SUCCESS') pass++;
      }
      return pass / uniq.length;
    };

    const baseline = await runBatch();
    candidate.apply?.();
    let after = baseline, ok = true;
    try { after = await runBatch(); } catch { after = -1; }
    const regressionPp = (baseline - after) * 100;
    if (regressionPp > CONFIG.GOLDEN_REGRESSION_PP || after < 0) {
      candidate.revert?.();
      ok = false;
    }
    return { pass: ok, baseline, after, regressionPp: Number(regressionPp.toFixed(2)), ran: uniq.length };
  }

  printTrace(trace, extra = {}) {
    const icon = trace.outcome === 'SUCCESS' ? '✅' : '❌';
    console.log(`\n${icon} 任务 ${trace.outcome}（${trace.basis}，${trace.duration_ms}ms）`);
    if (trace.plan?.steps?.length) console.log(`   规划：${trace.plan.steps.map((s) => s.goal).join(' → ')}`);
    if (trace.answer) console.log(`   回答：${trace.answer.slice(0, 200)}`);
    if (trace.error) console.log(`   错误：${trace.error}`);
    if (extra.budgetWarn) console.log('   ⚠️ 日 token 预算已触顶：进化/深度净化已降级（仅规则性净化）');
  }
}
