// config/index.js —— 唯一人工配置层（指导书 §4.1）
// 三种来源按优先级：环境变量 > config/local.json（gitignore） > 内置默认值
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let local = {};
const localPath = join(ROOT, 'config', 'local.json');
if (existsSync(localPath)) {
  try { local = JSON.parse(readFileSync(localPath, 'utf8')); } catch { /* 坏配置忽略，走默认 */ }
}

const env = process.env;

/** 阈值结构：[下界, 默认, 上界]，自动调参只允许在界内游走（§8.3.1） */
export const BOUNDS = {
  RETRIEVAL_TOP_K: [4, 8, 16],
  MAX_CONTEXT_TOKEN: [2048, 4096, 32768],
  SKILL_PROMOTE_W: [0.50, 0.60, 0.70],
  SKILL_DEMOTE_W: [0.35, 0.45, 0.55],
  SKILL_PURGE_W: [0.15, 0.25, 0.35],
  W_SIM: [0.3, 0.6, 0.8],   // 检索分权重（自动调参可动，步长 ≤10%）
  W_QUALITY: [0.1, 0.25, 0.5],
  W_RECENCY: [0.05, 0.15, 0.35],
};

export const CONFIG = {
  // ── LLM（OpenAI 兼容可插拔：换 baseURL+model 即可切换后端）──
  LLM_API_KEY: env.SPA_API_KEY ?? local.LLM_API_KEY ?? '',
  LLM_BASE_URL: env.SPA_BASE_URL ?? local.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
  LLM_MODEL: env.SPA_MODEL ?? local.LLM_MODEL ?? 'deepseek-chat',
  LLM_TIMEOUT_MS: 60_000,
  LLM_MAX_RETRIES: 4,
  LLM_CONCURRENCY: 4,

  // ── Embedding（三级降级 §4.1.3：none=BM25 | openai-compatible=向量）──
  EMBEDDING_PROVIDER: env.SPA_EMBED_PROVIDER ?? local.EMBEDDING_PROVIDER ?? 'none',
  EMBEDDING_BASE_URL: env.SPA_EMBED_BASE_URL ?? local.EMBEDDING_BASE_URL ?? '',
  EMBEDDING_MODEL: env.SPA_EMBED_MODEL ?? local.EMBEDDING_MODEL ?? '',
  EMBEDDING_DIM: 0, // >0 时启用维度守护（切换需全量重算+快照）

  // ── 运行模式 ──
  MOCK: (env.SPA_MOCK ?? local.MOCK ?? '0') === '1',
  DATA_DIR: env.SPA_DATA_DIR ?? local.DATA_DIR ?? join(ROOT, 'data'),
  ROOT,

  // ── 上下文与检索 ──
  MAX_CONTEXT_TOKEN: BOUNDS.MAX_CONTEXT_TOKEN[1],
  RETRIEVAL_TOP_K: BOUNDS.RETRIEVAL_TOP_K[1],

  // ── 评分与状态机阈值（Wilson 下界域，迟滞带：晋升>降级>淘汰，间隔≥0.15）──
  SKILL_PROMOTE_W: BOUNDS.SKILL_PROMOTE_W[1],
  SKILL_DEMOTE_W: BOUNDS.SKILL_DEMOTE_W[1],
  SKILL_PURGE_W: BOUNDS.SKILL_PURGE_W[1],
  MEMORY_KEEP_LINE: 0.30,
  MIN_EVIDENCE_N: 5,
  IMMUNITY_HOURS: 48,
  QUARANTINE_TTL_DAYS: 30,
  SKILL_ZOMBIE_DAYS: 30,
  SKILL_FROZEN_OBSERVE_DAYS: 7,   // FROZEN 观察期（§6.2.3）

  // ── 自净化节奏 ──
  PURIFY_LIGHT_INTERVAL_MIN: 10,
  PURIFY_CHURN_LIMIT: 0.05,
  PURIFY_DAILY_CHURN_LIMIT: 0.20,
  PURIFY_JUDGE_CALL_CAP: 10,

  // ── 记忆/经验净化细则阈值 ──
  MEMORY_DUP_JACCARD: 0.85,
  EXPERIENCE_STALE_DAYS: 90,
  SKILL_DUP_JACCARD: 0.90,

  // ── 成本护栏（三层预算 §8.3，禁止自动调参放宽）──
  DAILY_TOKEN_BUDGET: 2_000_000,
  TASK_TOKEN_BUDGET: 50_000,
  PURIFY_CYCLE_TOKEN_BUDGET: 30_000,

  // ── 复审抽样（⑥ REVIEW §6.1）──
  REVIEW_SAMPLE_RATIO: 0.10,

  // ── 反振荡（§6.5）──
  ADVERSARIAL_FREEZE: 3,          // 血缘链生成-被净化 ≥3 次 → 冻结整链
  NET_RATE_ROLLBACK_LINE: -0.10,  // 净利率连续 3 周期 < -10% → 快照回滚
  NET_RATE_INSTABILITY: 0.20,     // 连续 3 周期 |nr|>20% → 失稳事件

  // ── 回归门禁（§10.1）──
  GOLDEN_REGRESSION_PP: 2,        // 成功率回归 ≤2pp 才可生效

  // ── 工具沙箱（§8.2/§9.2）──
  TOOLS_ENABLED: (env.SPA_TOOLS ?? local.TOOLS_ENABLED ?? '1') === '1',
  TOOL_WORKSPACE: env.SPA_TOOL_WORKSPACE ?? join(ROOT, 'data', 'workspace'),
  TOOL_TIMEOUT_MS: 15_000,
  TOOL_SHELL_ENABLED: (env.SPA_TOOL_SHELL ?? '0') === '1', // 默认禁用命令行工具
  TOOL_NET_WHITELIST: (local.TOOL_NET_WHITELIST ?? ['api.deepseek.com', 'api.agnes-ai.cn']),

  // ── 任务执行 ──
  PLAN_RETRY_MAX: 2,
  STEP_RETRY_MAX: 3,

  // ── 黄金集冷启动 ──
  GOLDEN_AUTO_MAX: 50,

  // ── 快照保留 ──
  SNAPSHOT_KEEP: 30,

  // ── 服务/面板/集群 ──
  DASHBOARD_PORT: Number(env.SPA_DASHBOARD_PORT ?? local.DASHBOARD_PORT ?? 3790),
  SERVE_PORT: Number(env.SPA_SERVE_PORT ?? local.SERVE_PORT ?? 3791),

  // ── 总开关（安全宪法允许的人工显式开关，运行期不可被进化修改）──
  AUTO_ROLLBACK: true,
  AUTO_PURIFY: true,
  AUTO_TUNE: true,
};

/** 校验阈值是否在界内（自动调参与人工修改共用此守卫） */
export function assertInBounds(key, value) {
  const b = BOUNDS[key];
  if (!b) return value;
  if (value < b[0] || value > b[2]) {
    throw new Error(`config ${key}=${value} 越界 [${b}]（安全边界，见指导书 §8.3.1）`);
  }
  return value;
}
