// core/llm-adapter.js —— OpenAI 兼容 Chat 适配层（§4.2）
// 职责：重试退避（仅 429/5xx/网络）、60s 超时、滑动窗口熔断、结构化输出管线、
//       判定器（双采样一致才采信，否则弃权）、token 用量计量（成本护栏·轻量版）
import { CONFIG } from '../config/index.js';
import { extractJSON, validateShape } from '../utils/parser.js';

// ── token 用量计量（三层预算 L1任务/L2周期/L3日 的数据源，标签化归集）──
const usage = { day: dayKey(), tokensIn: 0, tokensOut: 0, calls: 0, errors: 0 };
const usageByLabel = new Map(); // label -> { tokensIn, tokensOut, calls }
function dayKey(d = new Date()) { return d.toISOString().slice(0, 10); }
function freshLabelUsage() { return { tokensIn: 0, tokensOut: 0, calls: 0 }; }
export function getUsage(label = null) {
  const today = dayKey();
  if (usage.day !== today) {
    usage.day = today; usage.tokensIn = 0; usage.tokensOut = 0; usage.calls = 0; usage.errors = 0;
    usageByLabel.clear();
  }
  if (label != null) return { ...(usageByLabel.get(label) ?? freshLabelUsage()) };
  return { ...usage };
}
/** 某标签剩余预算（L1 任务 50k / L2 净化周期 30k） */
export function labelBudgetLeft(label, budget) {
  const u = getUsage(label);
  return budget - (u.tokensIn + u.tokensOut);
}
export function budgetExhausted() {
  return getUsage().tokensIn + getUsage().tokensOut >= CONFIG.DAILY_TOKEN_BUDGET;
}
function recordUsage(u, label) {
  const tin = u?.prompt_tokens ?? 0, tout = u?.completion_tokens ?? 0;
  usage.tokensIn += tin; usage.tokensOut += tout;
  if (label != null) {
    const l = usageByLabel.get(label) ?? freshLabelUsage();
    l.tokensIn += tin; l.tokensOut += tout; l.calls++;
    usageByLabel.set(label, l);
  }
}

// ── 熔断器：5 分钟窗口错误率 >50% 或连续 5 次失败 → 熔断 10 分钟 ──
const breaker = { window: [], consecutiveFails: 0, openUntil: 0 };
function breakerAllows(now = Date.now()) {
  if (now < breaker.openUntil) return false;
  if (breaker.openUntil && now >= breaker.openUntil) breaker.openUntil = 0; // 半开
  return true;
}
function breakerRecord(ok, now = Date.now()) {
  breaker.window.push({ t: now, ok });
  breaker.window = breaker.window.filter((x) => now - x.t < 300_000);
  breaker.consecutiveFails = ok ? 0 : breaker.consecutiveFails + 1;
  const fails = breaker.window.filter((x) => !x.ok).length;
  if (!ok && (breaker.consecutiveFails >= 5 || (breaker.window.length >= 4 && fails / breaker.window.length > 0.5))) {
    breaker.openUntil = now + 600_000;
  }
}

// ── 运行时热配置（Web 界面改 Key/模型即时生效，免重启）──
const runtime = {};
export function setRuntimeConfig(cfg) { Object.assign(runtime, cfg); }
export function effectiveLLM() {
  return {
    apiKey: runtime.apiKey ?? CONFIG.LLM_API_KEY,
    baseUrl: runtime.baseUrl ?? CONFIG.LLM_BASE_URL,
    model: runtime.model ?? CONFIG.LLM_MODEL,
  };
}

/** 连接测试（Web 配置页「测试连接」按钮） */
export async function pingLLM({ baseUrl, apiKey, model } = {}) {
  if (CONFIG.MOCK) return { ok: true, latencyMs: 1, reply: 'mock', mock: true };
  const eff = effectiveLLM();
  const url = baseUrl ?? eff.baseUrl;
  const key = apiKey ?? eff.apiKey;
  const mdl = model ?? eff.model;
  if (!key) return { ok: false, error: '未配置 API Key' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  const start = Date.now();
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: mdl, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const data = await res.json();
    return { ok: true, latencyMs: Date.now() - start, reply: (data?.choices?.[0]?.message?.content ?? '').slice(0, 60) };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 原始 chat 调用（带重试/超时/熔断/标签计量）。MOCK 模式走 mockChat。 */
export async function chat({ messages, temperature = 0.2, json = false, maxTokens = 2048, label = null }) {
  if (CONFIG.MOCK) {
    usage.calls++;
    const r = mockChat({ messages });
    recordUsage(r.usage, label);
    return r;
  }
  const eff = effectiveLLM();
  if (!eff.apiKey) throw new Error('未配置 LLM_API_KEY（config/local.json 或环境变量 SPA_API_KEY）');

  let lastErr;
  for (let attempt = 0; attempt <= CONFIG.LLM_MAX_RETRIES; attempt++) {
    if (!breakerAllows()) throw new Error('LLM 熔断中（10 分钟），任务排队稍后重试');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CONFIG.LLM_TIMEOUT_MS);
    try {
      usage.calls++;
      const res = await fetch(`${eff.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${eff.apiKey}` },
        body: JSON.stringify({ model: eff.model, messages, temperature, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`), { retryable: false });
      const data = await res.json();
      breakerRecord(true);
      recordUsage(data?.usage, label);
      return { text: data?.choices?.[0]?.message?.content ?? '', usage: data?.usage };
    } catch (err) {
      clearTimeout(timer);
      breakerRecord(false);
      usage.errors++;
      lastErr = err;
      const retryable = err.retryable || err.name === 'AbortError' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT';
      if (!retryable || attempt === CONFIG.LLM_MAX_RETRIES) throw err;
      await sleep(1000 * 2 ** attempt + Math.random() * 1000); // 指数退避 + 全抖动
    }
  }
  throw lastErr;
}

/**
 * 结构化输出管线（§4.2.1）：提取 → 容错修复 → 形状校验 → 携错重试 1 次 → 仍败弃权 null。
 * 调用方必须显式处理 null，禁止静默吞掉。
 */
export async function chatJson({ messages, validate, temperature = 0.2, label = 'json' }) {
  const attempt = async (extraMsg) => {
    const r = await chat({ messages: extraMsg ? [...messages, extraMsg] : messages, temperature, json: true, label });
    const parsed = extractJSON(r.text);
    const shape = validateShape(parsed, validate);
    return shape.ok ? shape.value : { __error: shape.error };
  };
  let out = await attempt();
  if (out?.__error) {
    out = await attempt({ role: 'user', content: `你上一条输出未通过校验：${out.__error}。请严格输出合法 JSON，不要任何多余文字。` });
  }
  return out?.__error ? null : out;
}

/**
 * 判定器（§4.2.2）：temperature=0 双采样，结论一致才返回；不一致 → 弃权 { abstain: true }。
 * judgePrompt 不得包含被判定实体的来源信息（判定与利益分离）。
 */
export async function judge({ system, question, options, label = 'judge' }) {
  if (CONFIG.MOCK) return mockJudge(question, options);
  const ask = async () => {
    const r = await chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `${question}\n只输出一个词，取值：${options.join(' | ')}` },
      ],
      temperature: 0, json: false, maxTokens: 16, label,
    });
    const text = (r.text ?? '').trim();
    const hit = options.find((o) => text.toUpperCase().includes(o.toUpperCase()));
    return hit ?? 'UNPARSEABLE';
  };
  const [s1, s2] = await Promise.all([ask(), ask()]);
  const meta = { model: CONFIG.LLM_MODEL, promptVer: 'v1', sample1: s1, sample2: s2 };
  if (s1 === s2 && s1 !== 'UNPARSEABLE') return { verdict: s1, abstain: false, meta };
  return { verdict: null, abstain: true, meta };
}

// ── Embedding（openai-compatible 端点；未配置时返回 null，检索自动回落 BM25，§4.1.3）──
const embedCache = new Map();
export async function embed(text) {
  if (CONFIG.MOCK || CONFIG.EMBEDDING_PROVIDER !== 'openai-compatible' || !CONFIG.EMBEDDING_BASE_URL) return null;
  const key = text.slice(0, 500);
  if (embedCache.has(key)) return embedCache.get(key);
  const res = await fetch(`${CONFIG.EMBEDDING_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.LLM_API_KEY}` },
    body: JSON.stringify({ model: CONFIG.EMBEDDING_MODEL, input: key }),
  }).then((r) => r.json()).catch(() => null);
  const vec = res?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) return null;
  if (CONFIG.EMBEDDING_DIM > 0 && vec.length !== CONFIG.EMBEDDING_DIM) {
    throw new Error(`Embedding 维度突变 ${vec.length} != ${CONFIG.EMBEDDING_DIM}（破坏性变更，须全量重算+快照）`);
  }
  const f32 = Float32Array.from(vec);
  embedCache.set(key, f32);
  if (embedCache.size > 2000) embedCache.delete(embedCache.keys().next().value);
  return f32;
}

// ═══════════ MOCK 模式（SPA_MOCK=1）：确定性离线假后端，供测试/演示 ═══════════
function mockChat({ messages }) {
  const text = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  // 内容寻址：同输入同输出（可复现）
  let h = 0;
  for (const ch of text) h = ((h * 31 + ch.charCodeAt(0)) | 0) >>> 0;
  const pick = (arr) => arr[h % arr.length];

  // 进化钩子：记忆抽取 / 复盘 / 技能提炼 / 记忆合并 / 技能修复 / Prompt 迭代（保证 MOCK 模式下进化→净化闭环可演示）
  if (text.includes('记忆抽取器')) {
    const task = text.match(/任务：(.+)/)?.[1]?.slice(0, 60) ?? '任务';
    return { text: JSON.stringify({ memories: [{ content: `关于「${task}」的可复用要点`, kind: 'semantic', importance: 0.6 }] }), usage: { prompt_tokens: 90, completion_tokens: 40 } };
  }
  if (text.includes('记忆合并器')) {
    return { text: JSON.stringify({ content: '合并后的记忆：保留双方一致要点并标注差异' }), usage: { prompt_tokens: 100, completion_tokens: 45 } };
  }
  if (text.includes('技能修复器')) {
    return { text: JSON.stringify({ steps: [{ goal: '理解任务并校验前置条件', action: 'reason' }, { goal: '按修复后步骤执行', action: 'reason' }, { goal: '给出最终回答', action: 'answer' }] }), usage: { prompt_tokens: 110, completion_tokens: 55 } };
  }
  if (text.includes('Prompt迭代器')) {
    return { text: JSON.stringify({ prompt: '你是任务规划器（v2 优化版）。把任务拆成 2-4 个可执行步骤，优先复用背景中的技能与经验。输出 JSON：{"steps":[{"goal":"...","action":"reason|answer|tool:<名>"}]}' }), usage: { prompt_tokens: 130, completion_tokens: 70 } };
  }
  if (text.includes('复盘器')) {
    const ok = text.includes('结果：SUCCESS');
    return { text: JSON.stringify({ summary: ok ? '按步骤推进即可完成任务' : '需在规划阶段确认步骤可执行性', rules: ['先理解任务再拆步'], pitfalls: ['不要跳过验证'], failure_taxonomy: ok ? null : 'plan' }), usage: { prompt_tokens: 110, completion_tokens: 50 } };
  }
  if (text.includes('技能提炼器')) {
    if (h % 3 === 0) return { text: JSON.stringify({ name: null }), usage: { prompt_tokens: 90, completion_tokens: 10 } };
    const task = text.match(/任务：(.+)/)?.[1]?.slice(0, 30) ?? 'task';
    return { text: JSON.stringify({ name: `mock_skill_${h % 97}`, scenario: task, description: `MOCK 提炼技能：${task}`, steps: [{ goal: '理解任务', action: 'reason' }, { goal: '给出回答', action: 'answer' }] }), usage: { prompt_tokens: 120, completion_tokens: 60 } };
  }

  if (text.includes('任务规划器')) {
    return { text: JSON.stringify({ steps: [{ goal: '理解任务并检索相关知识', action: 'reason' }, { goal: '综合给出最终回答', action: 'answer' }] }), usage: { prompt_tokens: 100, completion_tokens: 40 } };
  }
  if (text.includes('最终回答')) {
    return { text: pick(['按照记忆与经验中的要点，最终回答如下：已完成。', '综合上述步骤，最终回答：任务完成，结果符合预期。', '基于已知信息，最终回答：已按要求处理完毕。']), usage: { prompt_tokens: 120, completion_tokens: 50 } };
  }
  if (text.includes('按步骤推进')) {
    const task = text.match(/任务：(.+)/)?.[1]?.slice(0, 40) ?? '任务';
    return { text: `已结合背景推进「${task}」的分析。`, usage: { prompt_tokens: 100, completion_tokens: 40 } };
  }
  return { text: pick(['（中间步骤）已根据上下文推进。', '（中间步骤）信息充分，继续。', '（中间步骤）按计划执行。']), usage: { prompt_tokens: 80, completion_tokens: 30 } };
}

function mockJudge(question, options = []) {
  // 冲突/矛盾判定 → CONFLICT；复审问题 → JUSTIFIED（隔离正当）；任务审查 → SUCCESS；其余 → OK
  const conflict = /冲突|矛盾|相反|contradict/i.test(question);
  const review = options.includes('JUSTIFIED');
  const unjust = /证据不足|n<5|样本不足/i.test(question); // 复审发现原判定证据不足 → 翻案
  const taskReview = options.includes('SUCCESS');
  const verdict = conflict ? 'CONFLICT' : review ? (unjust ? 'UNJUSTIFIED' : 'JUSTIFIED') : taskReview ? 'SUCCESS' : 'OK';
  return { verdict, abstain: false, meta: { model: 'mock', promptVer: 'v1', sample1: verdict, sample2: verdict } };
}
