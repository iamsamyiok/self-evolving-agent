// tests/unit/tools-verify.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runVerify } from '../../core/tools-verify.js';

const WS = join(process.cwd(), '.tmp-verify-test');

function mkdSync() { const d = join(process.cwd(), '.tmp-verify-auto-' + Math.random().toString(36).slice(2, 8)); mkdirSync(d, { recursive: true }); return d; }

function setup() {
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  writeFileSync(join(WS, 'sample.txt'), 'Hello World\nLine 2\nLine 3\n');
  writeFileSync(join(WS, 'config.json'), '{"version":"1.0","name":"test"}');
}
function teardown() {
  try { unlinkSync(join(WS, 'sample.txt')); } catch {}
  try { unlinkSync(join(WS, 'config.json')); } catch {}
  try { require('node:fs').rmdirSync(WS); } catch {}
}

describe('tools-verify', () => {
  before(() => { setup(); });
  after(() => { teardown(); });

  test('contains 通过', () => {
    const r = JSON.parse(runVerify({
      rules: [{ type: 'contains', value: 'World' }],
      text: 'Hello World'
    }));
    assert.equal(r.passAll, true);
    assert.equal(r.passed, 1);
  });

  test('regex 通过', () => {
    const r = JSON.parse(runVerify({
      rules: [{ type: 'regex', value: '^\\d{3}-\\d{4}$' }],
      text: '123-4567'
    }));
    assert.equal(r.passAll, true);
  });

  test('json_valid 通过', () => {
    const r = JSON.parse(runVerify({
      rules: [{ type: 'json_valid' }],
      text: '{"a":1}'
    }));
    assert.equal(r.passAll, true);
  });

  test('json_valid 失败', () => {
    const r = JSON.parse(runVerify({
      rules: [{ type: 'json_valid' }],
      text: '{bad json'
    }));
    assert.equal(r.passAll, false);
  });

  test('min_length / max_length', () => {
    const r = JSON.parse(runVerify({
      rules: [
        { type: 'min_length', value: 3 },
        { type: 'max_length', value: 100 }
      ],
      text: 'abc'
    }));
    assert.equal(r.passAll, true);
    assert.equal(r.details[0].pass, true);
    assert.equal(r.details[1].pass, true);
  });

  test('file_exists 断言', () => {
    const r = JSON.parse(runVerify({
      rules: [{ type: 'file_exists', value: 'sample.txt' }],
      file: 'sample.txt'
    }, WS));
    assert.equal(r.passAll, true);
  });

  test('仅 file_exists 规则无需数据源', () => {
    const r = JSON.parse(runVerify({
      rules: [
        { type: 'file_exists', value: 'sample.txt' },
        { type: 'file_exists', value: 'config.json' },
        { type: 'file_exists', value: 'nope.txt' },
      ],
    }, WS));
    assert.equal(r.passAll, false);
    assert.equal(r.passed, 2);
    assert.equal(r.failed, 1);
  });

  test('line_count 断言：尾随换行不产生幻影行', () => {
    // sample.txt = 'Hello World\nLine 2\nLine 3\n' → 3 行（不是 4）
    const r = JSON.parse(runVerify({
      rules: [{ type: 'line_count', value: 3, op: '==' }],
      file: 'sample.txt'
    }, WS));
    assert.equal(r.passAll, true);
    assert.equal(r.details[0].actual, 3);
  });

  test('多规则混合：部分失败', () => {
    const r = JSON.parse(runVerify({
      rules: [
        { type: 'contains', value: 'World' },
        { type: 'contains', value: 'MISSING' }
      ],
      text: 'Hello World'
    }));
    assert.equal(r.passAll, false);
    assert.equal(r.passed, 1);
    assert.equal(r.failed, 1);
  });

  test('缺少 rules 抛错', () => {
    assert.throws(() => runVerify({ text: 'hi' }), /rules 必传/);
  });
});

test('verify：file_exists+contains 混合规则缺 file 参数时自动取 file_exists 路径做断言对象（planner 高频形态）', () => {
  const ws = mkdSync();
  writeFileSync(join(ws, 'report.md'), '# 报告\nLangGraph 与 CrewAI 对比', 'utf8');
  const rules = [
    { type: 'file_exists', value: 'report.md' },
    { type: 'contains', value: 'LangGraph' },
    { type: 'contains', value: 'CrewAI' },
  ];
  const r = JSON.parse(runVerify({ rules }, ws));
  assert.equal(r.passAll, true);
  assert.equal(r.passed, 3);
});

test('verify：自动推断数据源文件缺失 → 结构化 passAll:false 而非 throw（断言失败是结果不是异常）', () => {
  const ws = mkdSync();
  const rules = [
    { type: 'file_exists', value: 'missing.md' },
    { type: 'contains', value: 'x' },
  ];
  const r = JSON.parse(runVerify({ rules }, ws));
  assert.equal(r.passAll, false);
  assert.equal(r.passed, 0);
});

test('verify：显式传 file 但文件不存在仍 throw（静默空串会掩盖路径写错）', () => {
  const ws = mkdSync();
  assert.throws(() => runVerify({ rules: [{ type: 'contains', value: 'x' }], file: 'typo.md' }, ws), /文件不存在/);
});
