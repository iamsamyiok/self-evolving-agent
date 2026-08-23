// tests/unit/parser.test.js —— 结构化容错解析
import test from 'node:test';
import assert from 'node:assert';
import { extractJSON, validateShape } from '../../utils/parser.js';

test('直接 JSON', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
});

test('围栏代码块', () => {
  assert.deepEqual(extractJSON('说明如下\n```json\n{"steps":[{"goal":"x"}]}\n```\n以上'), { steps: [{ goal: 'x' }] });
});

test('前后夹杂解释文字', () => {
  assert.deepEqual(extractJSON('好的，这是结果 {"ok":true,"list":[1,2]} 请查收'), { ok: true, list: [1, 2] });
});

test('容错修复：中文标点与尾逗号', () => {
  assert.deepEqual(extractJSON('{"a"："x"，"b":2,}'), { a: 'x', b: 2 });
});

test('截断容错：未闭合补齐', () => {
  const v = extractJSON('{"memories":[{"content":"abc"');
  assert.equal(v.memories[0].content, 'abc');
});

test('完全无 JSON → null（调用方必须显式处理）', () => {
  assert.equal(extractJSON('抱歉我无法输出 JSON'), null);
});

test('validateShape', () => {
  assert.equal(validateShape({ a: 1 }, () => null).ok, true);
  assert.equal(validateShape(null, () => null).ok, false);
  assert.equal(validateShape({}, (v) => (v.a ? null : '缺 a')).error, '缺 a');
});
