// tests/unit/archive.test.js —— 任务档案层（B2）：BM25 检索历史成功任务 + 护栏文案
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchArchive, formatArchive } from '../../core/archive.js';

test('searchArchive：命中相关历史任务，排除失败/空答案/进行中，少于2条不索引', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spa-archive-'));
  process.env.SPA_DATA_DIR = dir;
  const { Store } = await import('../../core/store-base.js');
  const store = new Store(dir);
  const now = Date.now();
  const ins = store.db.prepare("INSERT INTO tasks (id, input, answer, outcome, outcome_basis, status, created_at) VALUES (?, ?, ?, ?, 'judge', 'done', ?)");
  ins.run('t1', '对比 React 和 Vue 的性能差异', 'React 用 fiber 架构，Vue 用细粒度响应式，基准测试显示…', 'SUCCESS', now - 5000);
  ins.run('t2', '帮我写一首关于春天的诗', '春风拂面柳如烟，燕子归来二月天…', 'SUCCESS', now - 4000);
  ins.run('t3', '对比 React 和 Svelte 的打包体积', null, 'FAIL', now - 3000); // 失败且无答案
  ins.run('t4', 'React 状态管理方案选型对比', '小型项目用 useState，中大型上 Zustand…', 'SUCCESS', now - 2000);
  // 单条库：不索引（独立库验证规模闸门）
  const dir2 = mkdtempSync(join(tmpdir(), 'spa-archive2-'));
  const store2 = new Store(dir2);
  store2.db.prepare("INSERT INTO tasks (id, input, answer, outcome, outcome_basis, status, created_at) VALUES ('s1', 'React 性能', '答案内容足够长的情况下', 'SUCCESS', 'judge', 'done', ?)").run(now);
  assert.equal(searchArchive(store2, 'React').length, 0);
  // 再加一条构成规模
  ins.run('t5', '对比 React 和 Solid 的响应式原理', 'Solid 用信号机制绕过 VDOM…', 'SUCCESS', now - 1000);
  const hits = searchArchive(store, '对比 React 性能');
  assert.ok(hits.length >= 1 && hits.length <= 3);
  assert.ok(hits.every((h) => /React/.test(h.input) || /React|fiber/.test(h.answer))); // 相关性命中
  assert.ok(!hits.some((h) => h.id === 't2')); // 无关任务不入选
  assert.ok(!hits.some((h) => h.id === 't3')); // 失败任务不入选
  // 空查询
  assert.equal(searchArchive(store, '   ').length, 0);
  // 无 store 容错
  assert.equal(searchArchive(null, 'x').length, 0);
});

test('formatArchive：注入文案带防带偏护栏，空命中返回空串', () => {
  assert.equal(formatArchive([]), '');
  assert.equal(formatArchive(null), '');
  const t = formatArchive([{ when: '2026-08-26 10:00', input: '对比 React 性能', answer: 'fiber 架构结论' }]);
  assert.match(t, /【过往任务档案】/);
  assert.match(t, /仅供参考/);
  assert.match(t, /禁止被旧任务带偏目标/);
  assert.match(t, /问：对比 React 性能/);
  assert.match(t, /答：fiber 架构结论/);
});
