// tests/unit/expand-step-refs.test.js —— 步骤引用展开（数据流依赖）单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandStepRefs } from '../../core/agent-executor.js';

const steps = [
  { goal: '检索', action: 'reason', output: '检索摘要', full: 'LangGraph 1.0 发布于 2026-01，图状态机架构' },
  { goal: '对比', action: 'reason', output: '对比摘要', full: '架构对比：LangGraph 图 / CrewAI 角色 / AutoGen 对话' },
  { goal: '无产出步骤', action: 'reason', output: null, full: undefined },
];

test('{{step:N}} 展开为第 N 步全文（full 优先于 output）', () => {
  const p = expandStepRefs({ path: 'r.md', content: '报告：{{step:1}}' }, steps);
  assert.equal(p.content, '报告：LangGraph 1.0 发布于 2026-01，图状态机架构');
});

test('{{prev}} 展开为上一步产出', () => {
  const p = expandStepRefs({ content: '{{prev}}' }, steps.slice(0, 2));
  assert.equal(p.content, '架构对比：LangGraph 图 / CrewAI 角色 / AutoGen 对话');
});

test('{{steps_all}} 展开为全部步骤产出拼接', () => {
  const p = expandStepRefs({ content: '{{steps_all}}' }, steps.slice(0, 2));
  assert.match(p.content, /【步骤1·检索】/);
  assert.match(p.content, /【步骤2·对比】/);
  assert.match(p.content, /LangGraph 1\.0/);
});

test('未匹配的自造占位符原样保留（后续工具报错进修复链，不静默写空）', () => {
  const p = expandStepRefs({ content: '{{报告内容}}' }, steps);
  assert.equal(p.content, '{{报告内容}}');
});

test('引用无产出的步骤保留占位符', () => {
  const p = expandStepRefs({ content: 'x{{step:3}}y' }, steps);
  assert.equal(p.content, 'x{{step:3}}y');
});

test('引用不存在的步骤序号保留占位符', () => {
  const p = expandStepRefs({ content: '{{step:99}}' }, steps);
  assert.equal(p.content, '{{step:99}}');
});

test('嵌套对象/数组递归展开', () => {
  const p = expandStepRefs({ rules: [{ type: 'contains', value: '{{step:1}}' }], meta: { note: '{{prev}}' } }, steps.slice(0, 2));
  assert.equal(p.rules[0].value, 'LangGraph 1.0 发布于 2026-01，图状态机架构');
  assert.equal(p.meta.note, '架构对比：LangGraph 图 / CrewAI 角色 / AutoGen 对话');
});

test('无 {{ 的字符串零开销直通（同一引用不变）', () => {
  const src = { content: '普通文本' };
  const p = expandStepRefs(src, steps);
  assert.equal(p.content, '普通文本');
});
