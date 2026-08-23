// core/agent-executor.js —— L6 执行内核（§5.4）：上下文装配（先预算后填充）→ 规划 → 分步执行 → 判定 → 轨迹落库
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { MemorySystem } from './memory-system.js';
import { ExperienceEngine, traceHash } from './experience-engine.js';
import { SkillSystem } from './skill-system.js';
import { chat, chatJson, judge, budgetExhausted } from './llm-adapter.js';
import { assembleWithinBudget } from '../utils/token-utils.js';

export class AgentExecutor {
  constructor(store = new Store()) {
    this.store = store;
    this.memory = new MemorySystem(store);
    this.experience = new ExperienceEngine(store);
    this.skills = new SkillSystem(store, this);
    this.evolveHooks = true; // 任务结束后触发进化钩子
    this.onTaskDone = null;  // 由 Loop 注入（调度进化/净化）
  }

  /** 上下文装配（§5.4 固定顺序：技能→记忆→经验→任务本体；先预算后填充，各类保底 1 条） */
  assembleContext(taskInput, skillOverride = null) {
    const skills = skillOverride
      ? [{ id: skillOverride.id, text: `技能「${skillOverride.name}」：${skillOverride.description} 步骤：${skillOverride.steps}`, weight: 1 }]
      : this.skills.retrieve(taskInput).map((r) => ({ id: r.row.id, text: `技能「${r.row.name}」：${r.row.description}`, weight: r.score }));
    const memories = this.memory.retrieve(taskInput).map((r) => ({ id: r.row.id, text: r.row.content, weight: r.score }));
    const experiences = this.experience.retrieve(taskInput).map((r) => ({
      id: r.row.id,
      text: `经验：${r.row.summary}；规则：${(JSON.parse(r.row.rules || '[]')).join('；')}`,
      weight: r.score,
    }));
    const assembled = assembleWithinBudget(
      [
        { name: '技能', items: skills },
        { name: '记忆', items: memories },
        { name: '经验', items: experiences },
      ],
      Math.floor(CONFIG.MAX_CONTEXT_TOKEN * 0.6)
    );
    // 检索命中即记账（技能命中 → last_used；经验/记忆已在 retrieve 内更新）
    return assembled
      .filter((s) => s.items.length)
      .map((s) => `【${s.name}】\n${s.items.map((i) => `- ${i.text}`).join('\n')}`)
      .join('\n\n');
  }

  /** 执行单个任务。opts: { assertion, skillOverride, silent, goldenCheck } */
  async runTask(input, opts = {}) {
    const start = Date.now();
    const id = uuid7();
    const budgetWarn = budgetExhausted();
    const context = this.assembleContext(input, opts.skillOverride ?? null);

    let plan = null, steps = [], answer = null, error = null;
    try {
      // ── 规划（重试 ≤ PLAN_RETRY_MAX）──
      for (let i = 0; i <= CONFIG.PLAN_RETRY_MAX && !plan; i++) {
        plan = await this.planOnce(input, context);
      }
      if (!plan) throw new Error('规划失败（LLM 弃权）');

      // ── 分步执行（步骤级重试 ≤ STEP_RETRY_MAX，超限判失败）──
      for (const step of plan.steps) {
        let output = null, tries = 0;
        while (output == null && tries <= CONFIG.STEP_RETRY_MAX) {
          tries++;
          const r = await chat({ messages: [
            { role: 'system', content: `你是任务执行者，按步骤推进。${context ? '可用背景：\n' + context : ''}` },
            { role: 'user', content: `任务：${input}\n当前步骤：${step.goal}\n已完成：${JSON.stringify(steps.map((s) => s.goal))}\n请输出本步骤结果（一段文字）。` },
          ], temperature: 0.3 });
          output = r.text?.trim();
          if (!output) output = null;
        }
        if (output == null) throw new Error(`步骤「${step.goal}」连续失败`);
        steps.push({ goal: step.goal, output: output.slice(0, 500) });
      }

      // ── 最终回答 ──
      const fin = await chat({ messages: [
        { role: 'system', content: '你是任务执行者。基于全部步骤输出最终回答（简洁、直接给结果）。' },
        { role: 'user', content: `任务：${input}\n步骤结果：${JSON.stringify(steps)}\n最终回答：` },
      ], temperature: 0.2 });
      answer = fin.text?.trim();
    } catch (e) {
      error = String(e?.message ?? e);
    }

    // ── 结果判定：黄金断言 > 判定器双采样（弃权按 FAIL 记但标记 judge_abstain）──
    let outcome = 'FAIL', basis = 'error';
    if (!error) {
      const judged = this.checkAssertion(input, answer, opts.assertion);
      if (judged.__pendingJudge) {
        const j = await this.judgeOutcome(input, answer);
        outcome = j.outcome; basis = j.basis;
      } else {
        outcome = judged.outcome; basis = judged.basis;
      }
    }

    const duration = Date.now() - start;
    const trace = { id, input, plan, steps, answer, outcome, basis, error, duration_ms: duration };
    await runExclusive('task:write', () => {
      this.store.db.prepare(
        `INSERT INTO tasks (id, input, plan, steps, answer, outcome, outcome_basis, tokens_in, tokens_out, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
      ).run(id, input, plan ? JSON.stringify(plan) : null, JSON.stringify(steps), answer, outcome, basis, error, duration, Date.now());
    });

    // ── 进化钩子（异步不阻塞；任务失败也是进化素材）──
    if (this.evolveHooks && !opts.goldenCheck) {
      this._evolveTail = (async () => {
        try {
          await Promise.allSettled([
            this.memory.extractFromTrace(trace),
            this.experience.retrospect(trace),
            this.skills.distillFromTrace(trace).then((r) => r?.status === 'draft' && this.skills.verifyDraft(r.id)),
            this.goldenColdStart(trace),
          ]);
          // 技能命中记账（上下文装配用了技能则成败归因到技能）
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

  planOnce(input, context) {
    return chatJson({
      messages: [
        { role: 'system', content: '你是任务规划器。把任务拆成 2-4 个可执行步骤。输出 JSON：{"steps":[{"goal":"...","action":"reason|answer"}]}' },
        { role: 'user', content: `${context ? '背景：\n' + context + '\n\n' : ''}任务：${input}` },
      ],
      validate: (v) => (!Array.isArray(v?.steps) || v.steps.length < 1 ? '须含非空 steps 数组'
        : v.steps.some((s) => typeof s?.goal !== 'string') ? '每个步骤须有 goal' : null),
      label: 'plan',
    }).then((plan) => {
      if (!plan) return null;
      plan.steps = plan.steps.slice(0, 4).map((s) => ({ goal: String(s.goal).slice(0, 120), action: s.action === 'answer' ? 'answer' : 'reason' }));
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

  /** 异步 judge 判定（checkAssertion 返回 __pendingJudge 时由 runTask 调用） */

  async judgeOutcome(input, answer) {
    const r = await judge({
      system: '你是任务结果审查器，判断回答是否完成了任务要求。',
      question: `任务：「${input.slice(0, 200)}」\n回答：「${(answer ?? '').slice(0, 300)}」\n回答是否成功完成任务？`,
      options: ['SUCCESS', 'FAIL'],
    });
    if (r.abstain) return { outcome: 'FAIL', basis: 'judge_abstain' };
    return { outcome: r.verdict, basis: 'judge' };
  }

  /** 黄金集冷启动（§5.1.5 / §10.1）：前 N 个有判定结果的任务沉淀为黄金任务 */
  async goldenColdStart(trace) {
    const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM golden_tasks').get().n;
    if (count >= CONFIG.GOLDEN_AUTO_MAX) return;
    if (trace.basis === 'judge_abstain' || !trace.answer) return;
    this.store.db.prepare('INSERT INTO golden_tasks (id, input, assertion, origin, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(uuid7(), trace.input, JSON.stringify({ type: 'judge', value: null }), 'cold-start', Date.now());
  }

  chargeSkills(input, ok) {
    for (const r of this.skills.retrieve(input, 3)) {
      this.skills.recordExecution(r.row.id, ok);
    }
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
