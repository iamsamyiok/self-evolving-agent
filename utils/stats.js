// utils/stats.js —— Wilson / EMA / 迟滞 / 质量分 的唯一实现（指导书 §4.3：禁止各模块另写公式）
const z = 1.96;

/**
 * Wilson 95% 置信下界。禁止任何模块使用原始成功率做晋升/淘汰决策（附录 B-1）。
 * 例：1 次全成功 → 0.20（证据不足，不敢说好）；50 次全成功 → 0.94。
 */
export function wilsonLowerBound(successes, n) {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const inner = (p * (1 - p)) / n + z2 / (4 * n * n);
  const num = p + z2 / (2 * n) - z * Math.sqrt(inner);
  return num / (1 + z2 / n);
}

/** 时近性得分：exp(−Δt / 14d)，两周衰减（§3.4） */
export function recencyScore(lastUsedAt, now = Date.now()) {
  if (!lastUsedAt) return 0;
  const dtDays = (now - lastUsedAt) / 86_400_000;
  return Math.exp(-dtDays / 14);
}

/** 样本覆盖度：min(1, n/20)（§3.4） */
export function coverageScore(n) {
  return Math.min(1, n / 20);
}

/**
 * 复合质量分 Q（技能默认权重）：
 * Q = 0.5·W + 0.3·recency + 0.2·coverage；n < MIN_EVIDENCE_N 时封顶 0.55。
 */
export function qualityScore({ successCount = 0, failCount = 0, executionCount = 0, lastUsedAt = null, minEvidenceN = 5, now = Date.now() }) {
  const n = executionCount || (successCount + failCount);
  const w = wilsonLowerBound(successCount, n);
  let q = 0.5 * w + 0.3 * recencyScore(lastUsedAt, now) + 0.2 * coverageScore(n);
  if (n < minEvidenceN) q = Math.min(q, 0.55);
  return Math.max(0, Math.min(1, q));
}

/**
 * 记忆重要度带遗忘曲线：I(t) = I₀·e^(−λΔt) × (1 + 0.1·ln(1+access))（§3.4-3）
 * λ 按 tier：instant 1.0 / short 0.1 / long 0.02（单位 1/天）
 */
export function memoryImportance({ importance = 0.5, tier = 'short', accessCount = 0, createdAt, now = Date.now() }) {
  const lambda = { instant: 1.0, short: 0.1, long: 0.02 }[tier] ?? 0.1;
  const dtDays = Math.max(0, (now - createdAt) / 86_400_000);
  return importance * Math.exp(-lambda * dtDays) * (1 + 0.1 * Math.log(1 + accessCount));
}

/** 迟滞判定：给出一对 (当前态, 值) 与成对阈值，返回应处档位（§6.5-1）
 * thresholds 例：{ promote: 0.60, demote: 0.45, purge: 0.25 }
 * 返回 'promote' | 'hold' | 'demote' | 'purge'
 */
export function hysteresis(value, thresholds) {
  const { promote, demote, purge } = thresholds;
  if (value >= promote) return 'promote';
  if (value >= demote) return 'hold';
  if (value >= purge) return 'demote';
  return 'purge';
}

/** EMA 指数移动平均 */
export function ema(prev, value, alpha = 0.3) {
  if (prev == null || Number.isNaN(prev)) return value;
  return alpha * value + (1 - alpha) * prev;
}

/** 净利率 = (进化新增质量分 − 净化清除质量分) / 总质量分（§1.4） */
export function netRate(addedQ, removedQ, totalQ) {
  if (totalQ <= 0) return 0;
  return (addedQ - removedQ) / totalQ;
}
