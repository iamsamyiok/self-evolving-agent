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
};

export const CONFIG = {
  // ── LLM（OpenAI 兼容可插拔：换 baseURL+model 即可切换后端）──
  LLM_API_KEY: env.SPA_API_KEY ?? local.LLM_API_KEY ?? '',
  LLM_BASE_URL: env.SPA_BASE_URL ?? local.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
  LLM_MODEL: env.SPA_MODEL ?? local.LLM_MODEL ?? 'deepseek-chat',
  LLM_TIMEOUT_MS: 60_000,
  LLM_MAX_RETRIES: 4,
  LLM_CONCURRENCY: 4,

  // ── 运行模式 ──
  MOCK: (env.SPA_MOCK ?? local.MOCK ?? '0') === '1', // 离线演示/测试：LLM 返回确定性假响应
  DATA_DIR: env.SPA_DATA_DIR ?? local.DATA_DIR ?? join(ROOT, 'data'),
  ROOT,

  // ── 上下文与检索 ──
  MAX_CONTEXT_TOKEN: BOUNDS.MAX_CONTEXT_TOKEN[1],
  RETRIEVAL_TOP_K: BOUNDS.RETRIEVAL_TOP_K[1],

  // ── 评分与状态机阈值（Wilson 下界域，迟滞带：晋升>降级>淘汰，间隔≥0.15）──
  SKILL_PROMOTE_W: BOUNDS.SKILL_PROMOTE_W[1],
  SKILL_DEMOTE_W: BOUNDS.SKILL_DEMOTE_W[1],
  SKILL_PURGE_W: BOUNDS.SKILL_PURGE_W[1],
  MEMORY_KEEP_LINE: 0.30,      // 长期记忆重要度留存线（I 值低于此进入净化候选）
  MIN_EVIDENCE_N: 5,           // 最小证据次数（n<5 禁止一切淘汰类净化）
  IMMUNITY_HOURS: 48,          // 新生免疫期
  QUARANTINE_TTL_DAYS: 30,     // 隔离区保留天数
  SKILL_ZOMBIE_DAYS: 30,       // 冷层僵尸判定

  // ── 自净化节奏 ──
  PURIFY_LIGHT_INTERVAL_MIN: 10, // 轻量净化间隔（±20% 抖动）
  PURIFY_CHURN_LIMIT: 0.05,      // 单周期变更率上限（活性实体 5%）
  PURIFY_DAILY_CHURN_LIMIT: 0.20,// 单日累计变更率上限
  PURIFY_JUDGE_CALL_CAP: 10,     // 单周期判定器 LLM 调用上限（成本护栏·轻量版）

  // ── 记忆/经验净化细则阈值 ──
  MEMORY_DUP_JACCARD: 0.85,      // 冗余候选：同层 Jaccard ≥ 此值
  EXPERIENCE_STALE_DAYS: 90,     // 经验失效：零命中天数
  SKILL_DUP_JACCARD: 0.90,       // 技能冗余（第二阶段启用合并，MVP 仅检测）

  // ── 成本护栏（轻量版：仅日预算）──
  DAILY_TOKEN_BUDGET: 2_000_000,

  // ── 任务执行 ──
  PLAN_RETRY_MAX: 2,
  STEP_RETRY_MAX: 3,

  // ── 黄金集冷启动 ──
  GOLDEN_AUTO_MAX: 50,           // 前 N 个判定成功的任务自动沉淀为黄金集（§5.1.5）

  // ── 快照保留 ──
  SNAPSHOT_KEEP: 30,
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
