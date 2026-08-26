// tests/unit/tools-stat.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runStat } from '../../core/tools-stat.js';

const TMP = join(process.cwd(), '.tmp-stat-test');
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
function mk(name, content) { writeFileSync(join(TMP, name), content); }
function rmDir() { try { require('node:fs').readdirSync(TMP).forEach((f) => unlinkSync(join(TMP, f))); require('node:fs').rmdirSync(TMP); } catch {} }

describe('tools-stat', () => {
  before(() => {
    mk('small.txt', 'hello\nworld\n');
    mk('cjk.md', '# 中文标题\n你好世界\n');
    mkdirSync(join(TMP, 'sub'), { recursive: true });
    mk('sub/nested.txt', 'nested content\n');
  });
  after(rmDir);

  test('文件统计：字符/行数/CJK', () => {
    const r = JSON.parse(runStat({ path: join(TMP, 'small.txt') }));
    assert.equal(r.type, 'file');
    assert.ok(r.lines > 0);
    assert.ok(r.chars >= 1);
    assert.equal(r.cjkChars, 0);
  });

  test('CJK 字符正确计数', () => {
    const r = JSON.parse(runStat({ path: join(TMP, 'cjk.md') }));
    assert.ok(r.cjkChars > 0, `expected cjkChars>0, got ${r.cjkChars}`);
  });

  test('目录统计', () => {
    const r = JSON.parse(runStat({ path: TMP }));
    assert.equal(r.type, 'directory');
    assert.ok(r.fileCount >= 3);
    assert.ok(r.totalBytes > 0);
  });

  test('路径不存在抛错', () => {
    assert.throws(() => runStat({ path: '/no/such/path' }), /路径不存在/);
  });

  test('缺少 path 抛错', () => {
    assert.throws(() => runStat({}), /须传/);
  });
});
