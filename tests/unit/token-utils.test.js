// tests/unit/token-utils.test.js —— token 估算与预算装配（各类保底 1 条）
import test from 'node:test';
import assert from 'node:assert';
import { estimateTokens, assembleWithinBudget } from '../../utils/token-utils.js';

test('中文 1 字 ≈ 0.6 token，英文按词', () => {
  assert.equal(estimateTokens('一二三'), 2); // 3*0.6=1.8 → 2
  assert.ok(estimateTokens('hello world test') > 0);
});

test('预算装配：超预算时各类末位淘汰、保底 1 条', () => {
  const sections = [
    { name: '记忆', items: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, text: `记忆条目${i}`.repeat(10) })) },
    { name: '经验', items: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, text: `经验条目${i}`.repeat(10) })) },
  ];
  const out = assembleWithinBudget(sections, 100);
  const total = out.reduce((a, s) => a + s.items.reduce((x, it) => x + it.tokens, 0), 0);
  assert.ok(total <= 100, `total=${total}`);
  for (const s of out) assert.ok(s.items.length >= 1, '每类保底 1 条');
});
