// core/agent-executor.js —— L6 执行内核（§5.4）：上下文装配（先预算后填充）→ 规划 → 分步执行（含工具/红线）→ 判定 → 轨迹落库
// v0.2：任务预算 L1 熔断、Prompt 版本化（策略净化地基）、检索权重可调参、工具步骤执行
import { createHash } from 'node:crypto';
import { CONFIG } from '../config/index.js';
import { Store, uuid7, runExclusive } from './store-base.js';
import { MemorySystem } from './memory-system.js';
import { ExperienceEngine, traceHash } from './experience-engine.js';
import { SkillSystem } from './skill-system.js';
import { ToolRuntime } from './tool-runtime.js';
import { loadDynamicTools } from './dynamic-tool-loader.js';
import { chat, chatJson, judge, budgetExhausted, labelBudgetLeft, getUsage, taskScope, isAborted, ABORT_ERR } from './llm-adapter.js';
import { assembleWithinBudget } from '../utils/token-utils.js';
import { checkStep } from './safety-constitution.js';

export const DEFAULT_PROMPTS = {
  planner: '你是任务规划器。把任务拆成可执行步骤：简单问题 2-3 步，复杂问题（多源查询/写码/多步计算/调研综合）可拆 5-8 步。输出 JSON：{"steps":[{"goal":"...","action":"reason|answer|tool:<名>","params":{}}]}。\n\n{{TOOL_SECTION}}\n\n重要说明：\n1. 只能使用上述列出的工具名，禁止编造工具名；参数名也必须与清单一致\n2. 数值计算必须用 tool:calc（精确计算），禁止心算\n3. 若任务涉及外部 API 查询（天气、搜索等），且存在对应技能，使用 tool:skill:<技能名>\n4. 写代码/数据处理/逻辑验证类任务：先写代码，再用 tool:run_js 运行验证结果正确性\n5. 能力拓展原则——缺专用工具时绝不能放弃，按序尝试：a) news_search 搜索获取实时信息（新闻/时事/热点等一切"模型训练数据之外"的信息）b) http_get 调已知公开免Key API（天气 https://api.open-meteo.com/v1/forecast?latitude=xx&longitude=xx&current_weather=true；汇率 https://open.er-api.com/v6/latest/USD 等，坐标等前置知识用 reason 步骤推出——http_get 只用于你确切知道完整 URL 的 API，禁止用它拼搜索引擎页面 URL，搜索一律用 news_search）c) run_js 写代码自行实现（解析/转换/生成类任务）d) reason 步骤用自身知识直接完成。穷尽后才允许说明局限并给出所知最佳答案\n6. 遇到不会或不确定的问题时，优先用 news_search 搜索网络获取信息后再解决，而不是直接给出可能过时或编造的答案；信息类任务（新闻/数据/行情）的结论必须基于 news_search 返回的真实内容，禁止凭空编造新闻、数据或来源\n7. 简单问题直接用 reason/answer 步骤，无需工具\n8. 若背景已含【预检索结果】且数据足以支撑任务：直接基于它规划"提炼/综合/整理"类步骤，禁止规划"确认当前日期""确认时间范围"等冗余前置步骤（当前时间已注入提示，无需再确认）',
  step: '你是任务执行者，按步骤推进。',
  final: '你是任务执行者。基于全部步骤输出最终回答（简洁、直接给结果）。',
};

export class AgentExecutor {
  constructor(store = new Store()) {
    this.store = store;
    this.memory = new MemorySystem(store);
    this.experience = new ExperienceEngine(store);
    this.skills = new SkillSystem(store, this);
    this.tools = new ToolRuntime(this.store);
    // 注入 skillSystem 引用，供 safety-constitution 校验 skill 工具
    this.tools.skillSystem = this.skills;
    // 热插拔工具：tools/ 目录下的自定义工具自动注册（失败单个跳过）
    loadDynamicTools(this.tools).then((names) => {
      if (names.length) console.log(`[tools] 热插拔已加载：${names.join(', ')}`);
    }).catch(() => { /* 热插拔失败不影响核心功能 */ });
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
    let base = this.store.activePrompt(role)?.content ?? DEFAULT_PROMPTS[role];
    // 时间感知（planner/step/final）：模型训练数据停在过去，不知道"今天"——
    // 不注入当前时间，"最近一周"会被换算成训练数据里的日期，产出过时/编造内容
    if (['planner', 'step', 'final'].includes(role)) {
      const n = new Date();
      const wk = '日一二三四五六'[n.getDay()];
      const pad = (x) => String(x).padStart(2, '0');
      const now = `${n.getFullYear()}年${n.getMonth() + 1}月${n.getDate()}日（周${wk}）${pad(n.getHours())}:${pad(n.getMinutes())}`;
      base += `\n\n当前时间：${now}。所有"最近/最新/今天/本周/此时"等相对时间一律以当前时间为准换算；你的训练数据早于当前时间，训练知识中的"近期/最新"内容大概率已过时。`;
    }
    if (role !== 'planner') return base;
    // 兼容升级：DB 中旧版 planner（硬编码工具清单）不含占位符时，回退到新默认模板
    if (!base.includes('{{TOOL_SECTION}}')) base = DEFAULT_PROMPTS.planner;
    // planner 动态注入真实工具 + 激活技能清单（与运行时注册表同源，杜绝幻影工具）
    const tools = this.tools.list()
      .filter((t) => !(t.name === 'shell') || CONFIG.TOOL_SHELL_ENABLED)
      .map((t) => {
        const ub = this.store.getState('user_toolbox', { runtime: true, network: true, fileio: true });
        if (['calc','run_js'].includes(t.name) && !ub.runtime) return null;
        if (t.name === 'http_get' && !ub.network) return null;
        if (t.name === 'news_search' && !ub.network) return null;
        if (/^fs_/.test(t.name) && !ub.fileio) return null;
        return `- ${t.name}：${t.desc}`;
      })
      .filter(Boolean)
      .join('\n');
    const skills = (this.skills?.active() ?? [])
      .map((s) => `- skill:${s.name}：${String(s.description).slice(0, 80)}`)
      .join('\n');
    return base.replace('{{TOOL_SECTION}}',
      `可用工具列表（只能用这些名字）：\n${tools}${skills ? `\n可用技能（用 tool:skill:<名> 调用）：\n${skills}` : ''}`);
  }

  /** 当前生效的检索权重（自动调参写 system_state，界内可回退，§6.2.5） */
  retrievalWeights() {
    return this.store.getState('tuned_retrieval', { sim: CONFIG.W_SIM_DEFAULT ?? 0.6, quality: 0.25, recency: 0.15 });
  }

  /** 上下文装配（§5.4 固定顺序；先预算后填充，各类保底 1 条）。返回 {text, used}，used 供前端展示「本次用了什么」
   * 反污染：描述运行时环境状态的过时经验（"工具未注册/不可用"类）不入上下文——环境已变，此类结论只会误导规划器。 */
  static STALE_ENV_PATTERN = /未注册|未找到.{0,6}工具|工具.{0,8}(不可用|未注册|不存在)|无可用工具|缺少必要工具|白名单|越权|安全策略(禁止|拦截|不允许)/;

  assembleContext(taskInput, skillOverride = null, convId = null) {
    const w = this.retrievalWeights();
    const used = { skills: [], memories: [], experiences: [] };
    const skills = skillOverride
      ? [{ id: skillOverride.id, text: `技能「${skillOverride.name}」：${skillOverride.description} 步骤：${skillOverride.steps}`, weight: 1 }]
      : this.skills.retrieve(taskInput, undefined, w).map((r) => {
          used.skills.push({ id: r.row.id, name: r.row.name, q: Number(r.row.quality_score.toFixed(2)) });
          return { id: r.row.id, text: `技能「${r.row.name}」：${r.row.description}`, weight: r.score };
        });
    // 本会话记忆权重 ×2：用户在当前对话里的偏好/纠正优先于全局记忆（跨会话串扰是规划器误判主因之一）
    const convBoost = (row) => {
      if (!convId || !row.entities) return 1;
      try { return JSON.parse(row.entities)?.conversation_id === convId ? 2 : 1; } catch { return 1; }
    };
    const memories = this.memory.retrieve(taskInput, undefined, w).map((r) => ({ ...r, score: r.score * convBoost(r.row) }))
      .sort((a, b) => b.score - a.score)
      .map((r) => {
        used.memories.push({ id: r.row.id, excerpt: r.row.content.slice(0, 40), q: Number(r.row.quality_score.toFixed(2)) });
        return { id: r.row.id, text: r.row.content, weight: r.score };
      });
    const experiences = this.experience.retrieve(taskInput, undefined, w)
      .filter((r) => {
        const stale = AgentExecutor.STALE_ENV_PATTERN.test(`${r.row.summary ?? ''}${r.row.rules ?? ''}`);
        if (!stale) used.experiences.push({ id: r.row.id, summary: r.row.summary.slice(0, 40), q: Number(r.row.quality_score.toFixed(2)) });
        return !stale;
      })
      .map((r) => ({
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
    const text = assembled
      .filter((s) => s.items.length)
      .map((s) => `【${s.name}】\n${s.items.map((i) => `- ${i.text}`).join('\n')}`)
      .join('\n\n');
    return { text, used };
  }

  /** 执行单个任务。opts: { assertion, skillOverride, silent, goldenCheck, label, quick, onProgress, isAborted } */
  async runTask(input, opts = {}) {
    // taskScope：把 progress 闭包与停止标志注入 LLM 适配层
    // （429 等待/令牌排队时上报状态；用户停止时长等待立即中断）
    return taskScope.run(
      {
        progress: (evt) => { try { opts.onProgress?.(evt); } catch { /* 进度回调失败不影响任务 */ } },
        aborted: typeof opts.isAborted === 'function' ? opts.isAborted : undefined,
      },
      () => this._runTask(input, opts),
    );
  }

  async _runTask(input, opts = {}) {
    const start = Date.now();
    const id = opts.taskId ?? uuid7(); // 外部预分配 ID：断线重连时前端可凭此查询结果
    const label = opts.label ?? `task:${id}`;
    const budgetWarn = budgetExhausted();
    let { text: context, used } = this.assembleContext(input, opts.skillOverride ?? null, opts.conversationId ?? null);
    let lastWaitEvt = 0;
    const progress = (evt) => {
      // 排队/限流等待事件节流：5s 窗口内只透传一条，避免事件风暴刷屏时间线与轮询重放膨胀
      if (evt?.stage === 'llm_wait') {
        const now = Date.now();
        if (now - lastWaitEvt < 5000) return;
        lastWaitEvt = now;
      }
      try { opts.onProgress?.(evt); } catch { /* 进度回调失败不影响任务 */ }
    };
    let plan = null, steps = [], answer = null, error = null;
    const degradeNotes = []; // 韧性降级记录（final 综合时如实告知用户）
    let replanned = 0; // 反射重规划次数
    try {
      // 快速模式实时性守卫：quick 是单次直答（无搜索），实时类问题直答必幻觉——自动升级完整模式
      const realtime = /最近|最新|今天|本周|近日|新闻|行情|现价|此刻|now|current|latest|today/i.test(input);
      if (opts.quick && realtime) {
        progress({ stage: 'replan', attempt: 0, reason: '问题涉及实时信息，快速模式自动转为搜索模式' });
        opts = { ...opts, quick: false };
      }
      // 预检索（规划信息地基）：实时/外部信息类任务先搜索真实数据再规划——
      // 规划器对外部现状纯靠猜，拆出的步骤常建立在过时假设上；预检索让步骤基于真实信息（成本：1 次免费搜索）
      const researchy = /调研|盘点|测评|行业|趋势|进展|动态|竞品|对比分析|评估报告|选型/.test(input);
      if (!opts.quick && (realtime || researchy) && isAborted() === false) {
        const ub = this.store.getState('user_toolbox', { runtime: true, network: true, fileio: true });
        if (ub.network && this.tools.get('news_search')) {
          try {
            // query 提炼：长指令式输入取主题主干，剥掉交付物要求（总结/写字数/列点），避免脏查询污染搜索
            let q = String(input.includes('【当前问题】') ? input.split('【当前问题】').pop() : input).trim();
            q = q.replace(/^(帮我|请你|请|麻烦)\s*(完成|做一下|查一下|整理)?/, '');
            const enumItem = q.match(/(?:^|[\s：:])\d{1,2}[.、]\s+(.+?)(?=[\s：:]\d{1,2}[.、]\s|$)/s); // 多步枚举任务：取首个编号子项作主题（空白分隔+1-2位编号，排除小数/版本号误配）
            if (enumItem) q = enumItem[1];
            else {
              const cut = q.search(/[,，。;；]/); // 首分句即信息需求，其后多为"总结/给出/写一段"类交付物要求
              if (cut >= 6) q = q.slice(0, cut);
            }
            q = q.replace(/^(搜索|查询|查找|检索|调研)\s*/, '').replace(/\s{2,}/g, ' ').trim().slice(0, 60) || input.slice(0, 60);
            // 发布意图限定：仅当查询明确涉及"发布/上新"时追加限定词；其余场景保持原查询，避免过度改写
            const refinedQuery = /(发布|推出|上新|release)/i.test(q) && !/最新.{0,4}消息/.test(q) ? `${q} 最新发布消息` : q;
            progress({ stage: 'pre_search', query: refinedQuery });
            const r = await this.tools.call('news_search', { query: refinedQuery, maxResults: 6 }, { taskId: label });
            const pre = String(r?.output ?? '').trim().slice(0, 4000);
            if (pre) {
              context = `${context}\n\n【预检索结果（真实网络搜索数据，比你的训练数据可靠）】\n${pre}\n（规划参考：若此数据已足够支撑任务，后续步骤直接基于它提炼综合，无需重复搜索；不足则规划进一步搜索步骤）`;
            }
          } catch { /* 预检索失败不阻塞：规划照常进行 */ }
        }
      }
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
          if (isAborted()) throw ABORT_ERR; // 用户停止：不再开始下一个步骤
          progress({ stage: 'step', idx: i + 1, total: plan.steps.length, goal: step.goal });
          const stepStart = Date.now();
          if (labelBudgetLeft(label, CONFIG.TASK_TOKEN_BUDGET) <= 0) {
            throw new Error('任务预算熔断（TASK_TOKEN_BUDGET 耗尽）');
          }
          let output = null, tries = 0;
          while (output == null && tries <= CONFIG.STEP_RETRY_MAX) {
            tries++;
            output = await this.execStepResilient(step, { input, steps, context, label }, progress).then((r) => {
              if (r.degraded && r.note) degradeNotes.push(r.note);
              return r.output;
            }).catch((e) => { throw e; });
            if (output == null && tries <= CONFIG.STEP_RETRY_MAX) {
              // reason 步骤返回空：带提示重试
              output = await this.execStep(step, { input, steps, context, label, degradeNote: '上一次输出为空，请输出实质性内容' });
            }
          }
           if (output == null) throw new Error(`步骤「${step.goal}」连续失败`);
           // 完整输出供 final 综合与 judge 使用；full 字段不落库（避免轨迹膨胀）
            steps.push({ goal: step.goal, action: step.action, output: String(output).slice(0, 500), full: String(output).slice(0, 4000) });
            progress({ stage: 'step_done', idx: i + 1, total: plan.steps.length, ms: Date.now() - stepStart, goal: step.goal, output: String(output).replace(/\s+/g, ' ').slice(0, 2000), preview: String(output).replace(/\s+/g, ' ').slice(0, 80) });
         }

        if (isAborted()) throw ABORT_ERR; // 用户停止：跳过最终综合（省一次 LLM 调用）
        progress({ stage: 'answer', label: '综合回答' });
        const stepsForFinal = steps.map(({ full, ...s }) => ({ ...s, output: full ?? s.output }));
        const fin = await chat({
          messages: [
            { role: 'system', content: this.prompt('final') },
            { role: 'user', content: `任务：${input}\n${degradeNotes.length ? `执行中韧性降级说明（如实告知用户，不掩饰）：\n${degradeNotes.map((n) => `- ${n}`).join('\n')}\n` : ''}步骤结果：${JSON.stringify(stepsForFinal)}\n最终回答（若步骤已产出具体信息如新闻条目/数据/列表，必须原样引用呈现，不得泛化省略）：` },
          ], temperature: 0.2, label,
          stream: true, onDelta: (d) => progress({ stage: 'delta', text: d }), // token 级打字机
        });
        answer = fin.text?.trim();
      }
    } catch (e) {
      error = String(e?.message ?? e);
      // 反射循环：可重规划类错误（步骤失败/规划失败）→ 带错误教训重新规划执行一次
      const replannable = !/熔断|429|预算|store_closed/.test(error) && !opts.quick;
      if (replanned < (CONFIG.REPLAN_MAX ?? 1) && replannable && labelBudgetLeft(label, CONFIG.TASK_TOKEN_BUDGET) > 10_000) {
        replanned++;
        progress({ stage: 'replan', reason: error.slice(0, 120), attempt: replanned });
        try {
          const lesson = `【上次尝试失败的教训】已完成步骤：${JSON.stringify(steps.map((s) => s.goal))}；错误：${error}。请换一种分解思路或工具组合避开该错误。`;
          const rePlan = await this.planOnce(`${input}\n${lesson}`, context, label);
          if (rePlan?.steps?.length) {
            plan = rePlan;
            const keepSteps = steps.length;
            for (const [i, step] of plan.steps.entries()) {
              if (labelBudgetLeft(label, CONFIG.TASK_TOKEN_BUDGET) <= 0) throw new Error('任务预算熔断（TASK_TOKEN_BUDGET 耗尽）');
              progress({ stage: 'step', idx: i + 1, total: plan.steps.length, goal: step.goal, replanned: true });
              const stepStart = Date.now();
              const r = await this.execStepResilient(step, { input, steps, context, label }, progress);
              if (r.output != null) {
                if (r.degraded && r.note) degradeNotes.push(r.note);
                steps.push({ goal: step.goal, action: step.action, output: String(r.output).slice(0, 500), full: String(r.output).slice(0, 4000) });
                progress({ stage: 'step_done', idx: i + 1, total: plan.steps.length, ms: Date.now() - stepStart, goal: step.goal, output: String(r.output).replace(/\s+/g, ' ').slice(0, 2000), preview: String(r.output).replace(/\s+/g, ' ').slice(0, 80) });
              }
            }
            if (steps.length > keepSteps) {
               progress({ stage: 'answer', label: '综合回答（重规划后）' });
               const stepsForFinal = steps.map(({ full, ...s }) => ({ ...s, output: full ?? s.output }));
               const fin = await chat({
                 messages: [
                   { role: 'system', content: this.prompt('final') },
                   { role: 'user', content: `任务：${input}\n${degradeNotes.length ? `执行中韧性降级说明（如实告知用户，不掩饰）：\n${degradeNotes.map((n) => `- ${n}`).join('\n')}\n` : ''}步骤结果：${JSON.stringify(stepsForFinal)}\n最终回答（若步骤已产出具体信息如新闻条目/数据/列表，必须原样引用呈现，不得泛化省略）：` },
                 ], temperature: 0.2, label,
                 stream: true, onDelta: (d) => progress({ stage: 'delta', text: d }), // token 级打字机
               });
              answer = fin.text?.trim() || null;
              if (answer) error = null; // 重规划后成功，清除错误
            }
          }
        } catch (e2) {
          error = String(e2?.message ?? e2);
        }
      }
    }

    let outcome = 'FAIL', basis = 'error';
    if (!error) {
      const judged = this.checkAssertion(input, answer, opts.assertion);
      if (judged.__pendingJudge) {
        // 低成本启发式优先（judge 降本）：步骤全成功 + 无降级 + 回答实质性（>30字或含列表/数字）→ 直接 SUCCESS，省一次 LLM 调用
        const solid = steps.length > 0
          && degradeNotes.length === 0
          && !replanned
          && (String(answer ?? '').length > 30 || /\d|[-•*]|\n/.test(String(answer ?? '')));
        if (solid && !opts.goldenCheck) {
          outcome = 'SUCCESS'; basis = 'heuristic';
        } else {
          const j = await this.judgeOutcome(input, answer, label);
          outcome = j.outcome; basis = j.basis;
        }
      } else {
        outcome = judged.outcome; basis = judged.basis;
      }
    }

    const duration = Date.now() - start;
    const trace = { id, input, plan, steps, answer, outcome, basis, error, duration_ms: duration, contextUsed: used, conversationId: opts.conversationId ?? null };
    const u = getUsage(label);
    const stepsForDb = steps.map(({ full, ...s }) => s); // full 仅在任务内使用，不入库
    await runExclusive('task:write', () => {
      this.store.db.prepare(
        `INSERT INTO tasks (id, input, plan, steps, answer, outcome, outcome_basis, tokens_in, tokens_out, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, input, plan ? JSON.stringify(plan) : null, JSON.stringify(stepsForDb), answer, outcome, basis, u.tokensIn, u.tokensOut, error, duration, Date.now());
    });

    // 进化钩子（异步不阻塞；日预算 L3 触顶 → 降级为仅规则性沉淀；令牌余量不足 → 让路给用户主任务）
    if (this.evolveHooks && !opts.goldenCheck) {
      this._evolveTail = taskScope.run({}, async () => {
        try {
          const degraded = budgetExhausted();
          // 免费限流让路：余量 <6 时跳过全部 LLM 类钩子（抽取/复盘/提炼/门禁），只做零成本记账。
          // 连续提问场景下进化钩子会把 20/min 配额吃光，导致用户下一个任务直接 429。
          const { tokensAvailable } = await import('./llm-adapter.js');
          const starved = tokensAvailable() < 6;
          if (starved) this.store.setState('evolve_skipped_low_tokens', { at: Date.now(), taskId: id });
          // 平凡任务（启发式判成功且 ≤2 步）跳过复盘/蒸馏：成功率不构成可沉淀方法论，省下配额让路后续任务
          const trivial = basis === 'heuristic' && (trace.steps?.length ?? 0) <= 2;
          await Promise.allSettled([
            degraded || starved ? null : this.memory.extractFromTrace(trace),
            degraded || starved || trivial ? null : this.experience.retrospect(trace),
            degraded || starved || trivial ? null : this.skills.distillFromTrace(trace).then((r) => r?.status === 'draft' && this.skills.verifyDraft(r.id)),
            this.goldenColdStart(trace),
          ]);
          if (context && outcome && error !== '已停止') this.chargeSkills(input, outcome === 'SUCCESS'); // 中止任务不惩罚技能
        } catch (e) {
          // store_closed = 正常停机竞态，静默；其余错误留痕供诊断
          if (String(e?.message) !== 'store_closed') {
            try { this.store.setState('last_evolve_error', String(e?.message ?? e)); } catch { /* 库已关闭则忽略 */ }
          }
        } finally {
          this.onTaskDone?.(trace);
        }
      });
    }

    if (!opts.silent) this.printTrace(trace, { budgetWarn });
    return trace;
  }

  /** 单步执行：tool:* 走沙箱运行时，其余走 LLM。opts.degradeNote 注入降级说明 */
  async execStep(step, { input, steps, context, label, degradeNote }) {
    const action = String(step.action ?? 'reason');
    if (action.startsWith('tool:')) {
      const toolName = action.slice(5);
      // skill:* 工具：执行对应技能的步骤序列
      if (toolName.startsWith('skill:')) {
        const skillName = toolName.slice(6);
        return this.executeSkillStep(skillName, step.params ?? {}, label);
      }
      const r = await this.tools.call(toolName, step.params ?? {}, { taskId: label });
      return r.output;
    }
    const r = await chat({
      messages: [
        { role: 'system', content: `${this.prompt('step')}${context ? '可用背景：\n' + context : ''}` },
        { role: 'user', content: `${degradeNote ? `【韧性降级】${degradeNote}\n本步骤工具执行失败，改用自身知识完成——若本步骤涉及实时/外部信息（新闻、数据、行情等），必须在结果开头声明"以下内容未经联网核实，基于模型训练数据，可能过时"，禁止编造具体新闻、数字或来源。\n` : ''}任务：${input}\n当前步骤：${step.goal}\n已完成：${JSON.stringify(steps.map((s) => s.goal))}\n请输出本步骤结果（一段文字）。` },
      ], temperature: 0.3, label,
    });
    return r.text?.trim() || null;
  }

  /** 工具参数修复：带错误信息让 LLM 修正参数（一次机会） */
  async fixToolParams(step, errMsg, { input, steps, label }) {
    const prior = (steps ?? []).filter((s) => s.output).slice(-3)
      .map((s) => `- ${s.goal}：${String(s.output).slice(0, 200)}`).join('\n'); // 前置步骤产出摘要：参数常依赖上一步结果（如搜索到的汇率）
    const fixed = await chatJson({
      messages: [
        { role: 'system', content: '你是工具参数修复器。工具调用失败，根据错误信息修正参数。输出 JSON：{"params":{}}。若错误无法通过改参数解决（如网络不可达、资源不存在），输出 {"params":null}。' },
        { role: 'user', content: `任务：${input}\n工具：${step.action}\n步骤目标：${step.goal}${prior ? `\n前置步骤结果（参数取值优先从这里来，禁止编造）：\n${prior}` : ''}\n原参数：${JSON.stringify(step.params ?? {})}\n可用工具清单：\n${this.tools.list().map((t) => `- ${t.name}：${t.desc}`).join('\n')}\n错误：${errMsg}\n请输出修正后的完整 params：` },
      ],
      validate: (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'params' in v ? null : '须含 params 字段'),
      label,
    }).catch(() => null);
    return fixed?.params && typeof fixed.params === 'object' ? { ...step, params: fixed.params } : null;
  }

  /** 韧性步骤执行：红线拦截/工具失败 → 参数修复 → 降级 reason，绝不因单步失败终止任务
   * 返回 { output, degraded, note } */
  async execStepResilient(step, ctx, progress) {
    const action = String(step.action ?? 'reason');
    if (!action.startsWith('tool:')) {
      const output = await this.execStep(step, ctx);
      return { output, degraded: false, note: null };
    }

    // 红线检查：拦截该步但任务继续（记录风险事件 + 降级 reason）
    const rc = checkStep(step, { toolRuntime: this.tools, config: CONFIG });
    if (!rc.ok) {
      this.store.setState('last_risk_event', { at: Date.now(), step: step.goal, reason: rc.reason });
      const note = `原计划 ${step.action} 被安全策略拦截（${rc.reason}），改用自身知识完成本步骤目标`;
      progress?.({ stage: 'degrade', goal: step.goal, to: 'reason', reason: rc.reason });
      const output = await this.execStep({ goal: step.goal, action: 'reason' }, { ...ctx, degradeNote: note });
      return { output, degraded: true, note };
    }

    // 工具执行：失败 → 修参数重试 → 仍败降级 reason
    try {
      const output = await this.execStep(step, ctx);
      return { output, degraded: false, note: null };
    } catch (e) {
      const errMsg = String(e?.message ?? e);
      if (/熔断|429|任务预算/.test(errMsg)) throw e; // infra 错误不降级，直接上抛
      progress?.({ stage: 'retry', goal: step.goal, error: errMsg.slice(0, 120) });
      const fixed = await this.fixToolParams(step, errMsg, ctx);
      if (fixed) {
        const rc2 = checkStep(fixed, { toolRuntime: this.tools, config: CONFIG });
        if (rc2.ok) {
          try {
            const output = await this.execStep(fixed, ctx);
            return { output, degraded: false, note: null }; // 参数修复属设计内路径（如 reason→tool 改写后补参数），不计降级、不强制 judge
          } catch (e2) { /* 落到降级 */ }
        }
      }
      const note = `工具 ${step.action} 执行失败（${errMsg.slice(0, 100)}），改用自身知识尽力完成本步骤目标`;
      progress?.({ stage: 'degrade', goal: step.goal, to: 'reason', reason: errMsg.slice(0, 100) });
      const output = await this.execStep({ goal: step.goal, action: 'reason' }, { ...ctx, degradeNote: note });
      return { output, degraded: true, note };
    }
  }

  /** 执行技能步骤序列（热插拔 skill 工具） */
  /** 技能参数模板插值：把 {{key}} / {key} 替换为用户传入参数值（递归处理字符串值） */
  interpolateParams(obj, vars) {
    if (obj == null || typeof obj !== 'object') return obj ?? {};
    const fill = (v) => {
      if (typeof v !== 'string') return v;
      return v
        .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`))
        .replace(/\{\s*(\w+)\s*\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
    };
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = (typeof v === 'object' && v !== null) ? this.interpolateParams(v, vars) : fill(v);
    return out;
  }

  async executeSkillStep(skillName, params, label) {
    const skill = this.skills.active().find((s) => s.name === skillName);
    if (!skill) throw new Error(`未找到技能 ${skillName}`);
    const steps = JSON.parse(skill.steps || '[]');
    if (!steps.length) throw new Error(`技能 ${skillName} 无步骤定义`);
    const results = [];
    for (const subStep of steps) {
      if (subStep.action === 'reason' || subStep.action === 'answer') {
        // 前序子步骤结果作为输入（链式传递：工具步骤的产出是 reason 步骤的分析对象，缺失即退化成幻觉）
        const prior = results.map((r) => `【${r.goal}】\n${String(r.output ?? '').slice(0, 2500)}`).join('\n\n');
        const r = await chat({
          messages: [
            { role: 'system', content: this.prompt('step') },
            { role: 'user', content: `【技能「${skillName}」步骤】${subStep.goal}${subStep.expected ? `\n（预期产出：${subStep.expected}）` : ''}\n参数：${JSON.stringify(params)}\n${prior ? `前序步骤结果（分析必须基于这些真实内容，禁止编造其中不存在的数据）：\n${prior}` : ''}\n请输出本步骤结果（一段文字）。` },
          ], temperature: 0.3, label,
        });
        results.push({ goal: subStep.goal, output: r.text?.trim() || '' });
      } else if (subStep.action.startsWith('tool:')) {
        let toolName = subStep.action.slice(5);
        // 子步骤提供模板/默认值，用户参数覆盖同名默认值；占位符用用户参数插值
        const rawParams = { ...(subStep.params ?? {}), ...params };
        let callParams = this.interpolateParams(rawParams, params ?? {});
        // 技能治愈：历史蒸馏的技能常固化 http_get+query（无 url，源自失败运行）——搜索意图改道 news_search
        if (toolName === 'http_get' && !callParams.url) {
          const q = callParams.query ?? callParams.keyword ?? callParams.search_query ?? callParams.q ?? callParams.topic;
          if (q) {
            toolName = 'news_search';
            callParams = { query: String(q), maxResults: callParams.max_results ?? callParams.maxResults ?? 8 };
          }
        }
        const r = await this.tools.call(toolName, callParams, { taskId: label });
        results.push({ goal: subStep.goal, output: r.output });
      }
    }
    return JSON.stringify(results);
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
      plan.steps = plan.steps.slice(0, CONFIG.PLAN_MAX_STEPS ?? 8).map((s) => {
        let action = String(s.action ?? '');
        // 裸名兜底：planner 偶尔漏 tool:/skill: 前缀直接写 "run_js" 或 "skill:xxx"，先补前缀再走后续归一化
        if (action && !action.startsWith('tool:') && action !== 'reason' && action !== 'answer') {
          if (action.startsWith('skill:') || this.tools.get(action)) action = `tool:${action}`;
          else {
            const bareSkill = (this.skills?.active() ?? []).find((k) => k.name === action);
            if (bareSkill) action = `tool:skill:${action}`;
            else if (this.tools.resolve(action)) action = `tool:${this.tools.resolve(action)}`;
            else action = 'reason';
          }
        }
        if (/^tool:/.test(action)) {
          const toolName = action.slice(5);
          // 泛化重写：未注册名先查技能池（LLM 常漏 skill: 前缀裸用技能名），再走别名表解析
          if (toolName.startsWith('skill:')) {
            /* 技能调用格式已正确 */
          } else if (!this.tools.get(toolName)) {
            const asSkill = (this.skills?.active() ?? []).find((s) => s.name === toolName);
            if (asSkill) action = `tool:skill:${toolName}`;
            else {
              const resolved = this.tools.resolve(toolName);
              if (resolved) action = `tool:${resolved}`;
            }
          }
        }
        // 确定性工具改写：planner 常把"计算/代码验证"类 goal 错配为 reason（提示词规则遵守率低，
        // 或半遵守：action=reason 却附 calc 式 params），按 goal 关键词后置纠正
        let params = (s.params && typeof s.params === 'object') ? s.params : undefined;
        if (action === 'reason') {
          if (/\d/.test(s.goal) && /(计算|算出|换算|相加|相减|相乘|相除|求和|百分比|多少(钱|元|块|人民币|美元))/.test(s.goal) && this.tools.get('calc')) {
            action = 'tool:calc';
            params = undefined; // reason 步携带的 expr 常含"汇率"类中文占位符（calc 白名单会拒），交由参数修复链按前置步骤产出重建
          } else if (/(验证|运行|执行|测试).{0,8}(代码|脚本|片段)|(用代码|编写验证)/.test(s.goal) && this.tools.get('run_js')) {
            action = 'tool:run_js';
            if (!params?.code) params = undefined; // 有 planner 写好的 code 则直接用，否则走参数修复链
          }
        }
        return {
          goal: String(s.goal).slice(0, 120),
          action: /^tool:[a-z0-9_:-]+$/.test(action) ? action : (action === 'answer' ? 'answer' : 'reason'),
          params,
        };
      });
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
    // 结论多在末尾（推导/列表/代码），纯头部截断会漏判：取头 600 + 尾 500
    // （列表型交付物条目多，截太狠判定器看不到完整内容会误判 FAIL）
    const a = String(answer ?? '');
    const shown = a.length > 1100 ? `${a.slice(0, 600)}\n……\n${a.slice(-500)}` : a;
    const r = await judge({
      system: '你是任务结果审查器，判断回答是否交付了任务的最终目标（最终交付物，如答案/结果/结论/内容本身）。回答无需展示中间过程（代码细节/工具调用过程/推理步骤）——只要最终交付物正确且切题即为 SUCCESS。回答含公式/代码/markdown 格式属正常。',
      question: `任务：「${input.slice(0, 200)}」\n回答：「${shown}」\n回答是否成功完成任务？`,
      options: ['SUCCESS', 'FAIL'],
      label,
      samples: 1, // 任务成败判定低风险：单采样省配额（净化决策才需双采样）
    });
    // abstain 宽容化：无法裁决且回答有实质内容（≥8 字符，简短正确答案如"1060"类也能过）时不判死
    if (r.abstain) {
      const substantive = String(answer ?? '').trim().length >= 8;
      return { outcome: substantive ? 'SUCCESS' : 'FAIL', basis: substantive ? 'judge_abstain_substantive' : 'judge_abstain_empty' };
    }
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
