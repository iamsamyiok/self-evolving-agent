// tests/unit/tools-verify.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runVerify } from '../../core/tools-verify.js';

const WS = join(process.cwd(), '.tmp-verify-test');
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

  test('line_count 断言', () => {
    // sample.txt 有 3 行（含末尾空行），用 >= 断言
    const r = JSON.parse(runVerify({
      rules: [{ type: 'line_count', value: 3, op: '>=' }],
      file: 'sample.txt'
    }, WS));
    assert.equal(r.passAll, true);
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
