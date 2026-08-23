// tests/unit/similarity.test.js —— BM25 / 分词 / 候选预筛 / Jaccard
import test from 'node:test';
import assert from 'node:assert';
import { tokenize, BM25Index, candidatePairs, jaccard } from '../../utils/similarity.js';

test('分词：CJK bigram + 拉丁词 + 去停用词', () => {
  const t = tokenize('SQLite 数据库内存优化');
  assert.ok(t.includes('sqlite'));
  assert.ok(t.some((x) => x === '数据' || x === '据库'));
  assert.deepEqual(tokenize('the and of'), []);
});

test('BM25：相关文档得分更高，归一 [0,1)', () => {
  const idx = new BM25Index([
    { id: 'a', text: 'SQLite WAL 模式与事务' },
    { id: 'b', text: 'HTTP 重试与熔断' },
    { id: 'c', text: 'SQLite 备份与快照' },
  ]);
  const hits = idx.search('SQLite 事务', 3);
  assert.equal(hits[0].id, 'a');
  assert.ok(hits[0].score > 0 && hits[0].score < 1);
  assert.ok(!hits.find((h) => h.id === 'b'));
});

test('候选预筛：高相似对召回且含 Jaccard 值', () => {
  const pairs = candidatePairs([
    { id: 'a', text: '项目使用 Node.js 22 内置 SQLite' },
    { id: 'b', text: '项目使用 Node.js 22 内置 SQLite' },
    { id: 'c', text: '完全无关的另一个话题关于天气' },
  ]);
  assert.ok(pairs.length >= 1);
  const ab = pairs.find((p) => (p.a === 'a' && p.b === 'b'));
  assert.ok(ab && ab.jaccard > 0.9);
});

test('Jaccard：空集与全同', () => {
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
});
