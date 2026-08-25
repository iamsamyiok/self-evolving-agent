// config/index.js —— 唯一人工配置层（指导书 §4.1）
// 三种来源按优先级：环境变量 > local.json（gitignore） > 内置默认值
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── 运行形态判定 ──
// 开发模式（仓库内有 config/local.json）：数据落仓库 data/，与历史行为一致
// 安装模式（npm i -g 后无该文件）：数据/配置全落 ~/.self-evolve/，跨版本升级不丢、无需写权限
export const IS_PACKAGED = !existsSync(join(ROOT, 'config', 'local.json'));
export const DATA_HOME = process.env.SPA_DATA_HOME ?? join(homedir(), '.self-evolve');

let local = {};
const localPath = IS_PACKAGED ? join(DATA_HOME, 'local.json') : join(ROOT, 'config', 'local.json');
if (IS_PACKAGED) mkdirSync(DATA_HOME, { recursive: true });
if (existsSync(localPath)) {
  try { local = JSON.parse(readFileSync(localPath, 'utf8')); } catch { /* 坏配置忽略，走默认 */ }
}
export { localPath };

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
  LLM_429_MAX_WAITS: Number(env.SPA_LLM_429_WAITS ?? local.LLM_429_MAX_WAITS ?? 5), // 429 专属耐心轮数：每轮重新排队令牌再试
  LLM_CONCURRENCY: 2,  // 降低并发，避免触发限流
  LLM_RATE_LIMIT_PER_MIN: 20,  // 每分钟最大请求数（免费版限制）

  // ── Embedding（三级降级 §4.1.3：none=BM25 | openai-compatible=向量）──
  EMBEDDING_PROVIDER: env.SPA_EMBED_PROVIDER ?? local.EMBEDDING_PROVIDER ?? 'none',
  EMBEDDING_BASE_URL: env.SPA_EMBED_BASE_URL ?? local.EMBEDDING_BASE_URL ?? '',
  EMBEDDING_MODEL: env.SPA_EMBED_MODEL ?? local.EMBEDDING_MODEL ?? '',
  EMBEDDING_API_KEY: env.SPA_EMBED_KEY ?? local.EMBEDDING_API_KEY ?? '', // 缺省回落主 LLM key（同源 provider 场景）
  EMBEDDING_DIM: env.SPA_EMBED_DIM ?? local.EMBEDDING_DIM ?? 0, // >0 时启用维度守护（切换需全量重算+快照）

  // ── 运行模式 ──
  MOCK: (env.SPA_MOCK ?? local.MOCK ?? '0') === '1',
  DATA_DIR: env.SPA_DATA_DIR ?? local.DATA_DIR ?? (IS_PACKAGED ? DATA_HOME : join(ROOT, 'data')),
  ROOT,
  // 访问鉴权：设置 SPA_AUTH_TOKEN 后所有 /api/* 需携带 Authorization: Bearer <token>；空则完全开放（本地/单人使用）
  AUTH_TOKEN: env.SPA_AUTH_TOKEN ?? local.AUTH_TOKEN ?? '',

  // ── 上下文与检索 ──
  MAX_CONTEXT_TOKEN: BOUNDS.MAX_CONTEXT_TOKEN[1],
  RETRIEVAL_TOP_K: BOUNDS.RETRIEVAL_TOP_K[1],
  // 检索索引缓存上界：ACTIVE 记忆超出后按温度（质量+重要性+时近性）保留最热子集（渐进式加载）
  MEMORY_INDEX_MAX_ROWS: Number(env.SPA_MEMORY_INDEX_MAX_ROWS ?? local.MEMORY_INDEX_MAX_ROWS ?? 20000),

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
  TOOL_WORKSPACE: env.SPA_TOOL_WORKSPACE ?? local.TOOL_WORKSPACE ?? (IS_PACKAGED ? join(DATA_HOME, 'workspace') : join(ROOT, 'data', 'workspace')),
  TOOL_TIMEOUT_MS: 15_000,
  TOOL_SHELL_ENABLED: (env.SPA_TOOL_SHELL ?? local.TOOL_SHELL_ENABLED ?? '1') === '1', // 默认启用命令行工具
  TOOL_NET_WHITELIST: (local.TOOL_NET_WHITELIST ?? ['api.deepseek.com', 'api.agnes-ai.cn', 'api.anysearch.com', 'news.google.com']),
  // 开放网络模式（默认开）：http_get 不再受白名单限制，可访问任意公网站点（仍拦私网 SSRF 与凭据外传）
  TOOL_NET_OPEN: (env.SPA_TOOL_NET_OPEN ?? local.TOOL_NET_OPEN ?? '1') === '1',
  // 用户级设置：由 LLM 配置模态框保存（热生效），不写本地.json
  USER_TOOLBOX_RUNTIME: true,  // 代码/计算工具（calc、run_js 等）
  USER_TOOLBOX_NETWORK: true,  // 网络工具（http_get）
  USER_TOOLBOX_FILEIO: true,   // 文件系统工具（fs_read/write/list）
  NEWS_API_KEY: env.NEWS_API_KEY ?? '',  // 可选：NewsAPI 密钥（免费层 100 次/天）
  ANYSEARCH_API_KEY: env.ANYSEARCH_API_KEY ?? '',  // 可选：AnySearch API Key（推荐注册获取更高配额）

  // ── 任务执行 ──
  PLAN_RETRY_MAX: 2,
  MEMORY_MIN_IMPORTANCE: 0.55, // 记忆入库门槛（低于此重要性的抽取候选直接丢弃）
  PLAN_MAX_STEPS: 8, // 复杂任务允许更深分解（规划器输出截断上限）
  REPLAN_MAX: 2, // 执行失败后的重新规划次数（每次前置预算守卫，耗尽自动停）
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
