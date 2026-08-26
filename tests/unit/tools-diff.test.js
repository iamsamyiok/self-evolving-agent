// tests/unit/tools-diff.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runDiff } from '../../core/tools-diff.js';

const TMP = join(process.cwd(), '.tmp-diff-test');
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
function mk(name, content) { writeFileSync(join(TMP, name), content); return join(TMP, name); }
function rm(...names) { for (const n of names) { try { unlinkSync(join(TMP, n)); } catch {} } }

describe('tools-diff', () => {
  before(() => {});
  after(() => rm('a.txt', 'b.txt'));

  test('输入对比：有差异', () => {
    const r = runDiff({ input_a: 'line1\nline2\nline3', input_b: 'line1\nchanged\nline3' });
    const j = JSON.parse(r);
    assert.equal(j.hasDiff, true);
    assert.ok(j.addedLines > 0);
    assert.ok(j.deletedLines > 0);
    assert.ok(j.unifiedDiff.includes('+ changed'));
    assert.ok(j.unifiedDiff.includes('- line2'));
  });

  test('输入对比：无差异', () => {
    const r = runDiff({ input_a: 'same', input_b: 'same' });
    const j = JSON.parse(r);
    assert.equal(j.hasDiff, false);
    assert.equal(j.addedLines, 0);
    assert.equal(j.deletedLines, 0);
  });

  test('文件对比', () => {
    const fa = mk('a.txt', 'alpha\nbeta\ngamma');
    const fb = mk('b.txt', 'alpha\ndelta\ngamma');
    const r = runDiff({ file_a: fa, file_b: fb });
    const j = JSON.parse(r);
    assert.equal(j.hasDiff, true);
    assert.ok(j.unifiedDiff.includes('- beta'));
    assert.ok(j.unifiedDiff.includes('+ delta'));
  });

  test('纯插入场景：新增行不误报删除', () => {
    const r = runDiff({ input_a: 'x', input_b: 'x\nNEW1\nNEW2' });
    const j = JSON.parse(r);
    assert.equal(j.hasDiff, true);
    assert.equal(j.addedLines, 2);
    assert.equal(j.deletedLines, 0);
    assert.ok(j.unifiedDiff.includes('+ NEW1'));
  });

  test('纯删除场景：删除行不误报新增', () => {
    const r = runDiff({ input_a: 'a\nb\nc', input_b: 'a\nc' });
    const j = JSON.parse(r);
    assert.equal(j.deletedLines, 1);
    assert.equal(j.addedLines, 0);
    assert.ok(j.unifiedDiff.includes('- b'));
  });

  test('缺少参数抛错', () => {
    assert.throws(() => runDiff({}), /须传入/);
    assert.throws(() => runDiff({ input_a: 'x' }), /须传入/);
  });

  test('文件不存在抛错', () => {
    assert.throws(() => runDiff({ file_a: '/no/such/file.txt', file_b: '/no/such/file2.txt' }), /文件不存在/);
  });
});
