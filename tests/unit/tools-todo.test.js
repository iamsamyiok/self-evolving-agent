// tests/unit/tools-todo.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTodo } from '../../core/tools-todo.js';

const WS = join(process.cwd(), '.tmp-todo-test');
function setup() {
  if (!existsSync(WS)) mkdirSync(WS, { recursive: true });
  writeFileSync(join(WS, '.todo.json'), JSON.stringify({ items: [], updated_at: null }));
}
function teardown() {
  try { unlinkSync(join(WS, '.todo.json')); } catch {}
  try { require('node:fs').rmdirSync(WS); } catch {}
}

function mkItem(name) {
  const d = { items: [], updated_at: null };
  writeFileSync(join(WS, '.todo.json'), JSON.stringify(d));
  runTodo({ action: 'add', text: name }, WS);
  return JSON.parse(runTodo({ action: 'list' }, WS)).items[0].id;
}

describe('tools-todo', () => {
  before(() => { setup(); });
  after(() => { teardown(); });

  test('list 初始为空', () => {
    const r = JSON.parse(runTodo({ action: 'list' }, WS));
    assert.equal(r.total, 0);
    assert.equal(r.pending, 0);
  });

  test('add 添加任务', () => {
    const msg = runTodo({ action: 'add', text: '完成文档', tag: 'docs' }, WS);
    assert.ok(msg.includes('完成文档'));
    const r = JSON.parse(runTodo({ action: 'list' }, WS));
    assert.equal(r.total, 1);
    assert.equal(r.items[0].text, '完成文档');
    assert.equal(r.items[0].tag, 'docs');
    assert.equal(r.items[0].done, false);
  });

  test('toggle 切换完成状态', () => {
    const id = mkItem('修复 Bug');
    const msg = runTodo({ action: 'toggle', id }, WS);
    assert.ok(msg.includes('✓'));
    const r = JSON.parse(runTodo({ action: 'list' }, WS));
    assert.equal(r.items[0].done, true);
    assert.equal(r.done, 1);
  });

  test('clear 清理已完成', () => {
    // 两件事：先加两个，完成其中一个，clear，确认只剩一个
    writeFileSync(join(WS, '.todo.json'), JSON.stringify({ items: [], updated_at: null }));
    runTodo({ action: 'add', text: 'A' }, WS);
    runTodo({ action: 'add', text: 'B' }, WS);
    const items = JSON.parse(runTodo({ action: 'list' }, WS)).items;
    runTodo({ action: 'toggle', id: items[0].id }, WS);
    const msg = runTodo({ action: 'clear' }, WS);
    const r = JSON.parse(runTodo({ action: 'list' }, WS));
    assert.equal(r.total, 1);
  });

  test('删除任务', () => {
    const id = mkItem('删除测试');
    runTodo({ action: 'delete', id }, WS);
    const r = JSON.parse(runTodo({ action: 'list' }, WS));
    assert.equal(r.total, 0);
  });

  test('缺少 action 抛错', () => {
    assert.throws(() => runTodo({}, WS), /未知 action/);
  });
});
