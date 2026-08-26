// tests/unit/intent.test.js —— 意图契约闭环（B1）：抽取/注记/硬断言/judge/返修路径
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intentWorthy, normalizePath, normalizeIntent, formatIntentNote, assertDeliverables, parseVerdict } from '../../core/intent.js';

test('intentWorthy 闸门：交付物型任务才启用，短问答零开销', () => {
  assert.equal(intentWorthy('对比 A、B、C 三个框架的优缺点并整理成清单'), true);
  assert.equal(intentWorthy('写一份 report.md 总结本次调研结论'), true);
  assert.equal(intentWorthy('你好'), false);
  assert.equal(intentWorthy('什么是量子计算'), false); // 短问答
});

test('normalizePath：绝对路径/工作区前缀归一为相对路径', () => {
  const ws = '/tmp/ws123';
  assert.equal(normalizePath('/tmp/ws123/report.md', ws), 'report.md');
  assert.equal(normalizePath('/abs/deep/path/a.md', ws), 'a.md');
  assert.equal(normalizePath('docs/api.md', ws), 'docs/api.md');
  assert.equal(normalizePath(null, ws), null);
  assert.equal(normalizePath('null', ws), null);
});

test('normalizeIntent：字段防御 + 空契约返回 null', () => {
  const n = normalizeIntent({ task: '写报告', goals: ['a', 42, 'b'], deliverables: [{ path: 'a.md', criterion: '存在' }, null, { bad: 1 }], acceptance: ['文件存在'], constraints: 'not-array' });
  assert.equal(n.task, '写报告');
  assert.deepEqual(n.goals, ['a', 'b']);
  assert.equal(n.deliverables.length, 2); // bad 条目保留但 path 为 null
  assert.equal(n.deliverables[0].path, 'a.md');
  assert.equal(n.constraints.length, 0);
  assert.equal(normalizeIntent(null), null);
  assert.equal(normalizeIntent({ task: '' }, '/ws'), null); // 全空
});

test('formatIntentNote：注记含交付物/验收/权威来源声明', () => {
  const note = formatIntentNote({ task: '写报告', goals: [], deliverables: [{ path: 'a.md', criterion: '存在' }], constraints: [], acceptance: ['已产出 a.md'] });
  assert.match(note, /意图契约/);
  assert.match(note, /交付物：a\.md——存在/);
  assert.match(note, /验收：已产出 a\.md/);
  assert.match(note, /权威来源/);
  assert.equal(formatIntentNote(null), '');
});

test('assertDeliverables：文件存在性硬断言（框架判定零 LLM）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intent-'));
  writeFileSync(join(dir, 'a.md'), 'x');
  const results = assertDeliverables({ deliverables: [{ path: 'a.md' }, { path: 'b.md' }, { path: null }] }, dir);
  assert.equal(results.length, 2); // path:null 跳过
  assert.match(results[0], /^PASS a\.md/);
  assert.match(results[1], /^FAIL b\.md/);
});

test('parseVerdict：围栏/垃圾输出按 PASS；GAPS 需带缺口', () => {
  assert.equal(parseVerdict('```json\n{"verdict":"PASS"}\n```').verdict, 'PASS');
  assert.deepEqual(parseVerdict('模型弃权非 JSON'), { verdict: 'PASS', gaps: [] });
  const g = parseVerdict('{"verdict":"GAPS","gaps":["缺 report.md", 42, "  "]}');
  assert.equal(g.verdict, 'GAPS');
  assert.deepEqual(g.gaps, ['缺 report.md']);
  assert.equal(parseVerdict('{"verdict":"GAPS","gaps":[]}').verdict, 'PASS'); // 空缺口按通过
});

test('MOCK 意图抽取 + judge：executor 闭环返修路径（GAPS→修复→PASS）', async () => {
  const { CONFIG } = await import('../../config/index.js');
  CONFIG.MOCK = true; // 静态导入链已加载（MOCK=false），运行时切换进 MOCK 后端
  const { extractIntent, judgeDelivery } = await import('../../core/intent.js');
  // 抽取：任务原文中的文件路径被识别为交付物
  const it = await extractIntent('请写一份 report.md 总结，并生成 data.json 清单文件', { wsDir: '/ws' });
  assert.ok(it, 'MOCK 抽取应成功');
  assert.deepEqual(it.deliverables.map((d) => d.path), ['report.md', 'data.json']);
  // judge：默认 PASS；任务带 INTENT_TEST_GAPS 标记返回缺口
  const pass = await judgeDelivery(it, '已完成', [], {});
  assert.equal(pass.verdict, 'PASS');
  const gapTask = { ...it, task: 'INTENT_TEST_GAPS ' + it.task };
  const gaps = await judgeDelivery(gapTask, '已完成', ['FAIL report.md（文件存在）'], {});
  assert.equal(gaps.verdict, 'GAPS');
  assert.ok(gaps.gaps.some((g) => /report\.md/.test(g)));
  CONFIG.MOCK = false;
});
