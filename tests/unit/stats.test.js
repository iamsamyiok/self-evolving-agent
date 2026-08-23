// tests/unit/stats.test.js —— Wilson 下界 / Q 封顶 / 迟滞 / 遗忘曲线
import test from 'node:test';
import assert from 'node:assert';
import { wilsonLowerBound, qualityScore, hysteresis, memoryImportance, netRate, ema, recencyScore } from '../../utils/stats.js';

test('Wilson 下界：小样本保守，防误杀误捧', () => {
  assert.ok(Math.abs(wilsonLowerBound(1, 1) - 0.203) < 0.01, `1/1 → ${wilsonLowerBound(1, 1)}`);
  assert.ok(Math.abs(wilsonLowerBound(50, 50) - 0.929) < 0.01, `50/50 → ${wilsonLowerBound(50, 50)}`);
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(1, 1) < 0.5, '1 次全成功不得高于 0.5（不敢说好）');
  assert.ok(wilsonLowerBound(2, 10) < 0.1);
});

test('质量分 Q：n<5 封顶 0.55（免疫期内不可能晋升/淘汰）', () => {
  const small = qualityScore({ successCount: 1, executionCount: 1, lastUsedAt: Date.now() });
  assert.ok(small <= 0.55, `n=1 Q=${small}`);
  const big = qualityScore({ successCount: 50, executionCount: 50, lastUsedAt: Date.now() });
  assert.ok(big > 0.55, `n=50 Q=${big}`);
});

test('迟滞带：晋升/保持/降级/淘汰四档', () => {
  const t = { promote: 0.60, demote: 0.45, purge: 0.25 };
  assert.equal(hysteresis(0.7, t), 'promote');
  assert.equal(hysteresis(0.5, t), 'hold');
  assert.equal(hysteresis(0.3, t), 'demote');
  assert.equal(hysteresis(0.1, t), 'purge');
  // 迟滞间隔 ≥0.15（容浮点 ε）
  const eps = 1e-9;
  assert.ok(t.promote - t.demote >= 0.15 - eps && t.demote - t.purge >= 0.15 - eps);
});

test('记忆遗忘曲线：long 衰减慢于 short', () => {
  const now = Date.now();
  const args = { importance: 1, accessCount: 0, createdAt: now - 30 * 86_400_000, now };
  assert.ok(memoryImportance({ ...args, tier: 'long' }) > memoryImportance({ ...args, tier: 'short' }));
});

test('时近性与净利率', () => {
  assert.ok(recencyScore(Date.now()) > recencyScore(Date.now() - 30 * 86_400_000));
  assert.ok(Math.abs(netRate(5, 5, 100)) < 1e-9);
  assert.equal(ema(0, 100, 0.3), 30);
});
