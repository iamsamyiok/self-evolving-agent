// makeExecView 渲染冒烟测试：前端执行视图两次运行时翻车（方法缺失/时序异常），
// node --check 只查语法，必须用 mock DOM 走真实调用链。
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 从 chat.html 提取 makeExecView 源码（顶级函数：起于定义，止于行首闭合大括号）──
const html = readFileSync(join(import.meta.dirname, '../../web/chat.html'), 'utf8');
const start = html.indexOf('function makeExecView');
assert.ok(start > 0, 'makeExecView 未找到');
const endMarker = html.indexOf('\n}', start);
assert.ok(endMarker > 0, 'makeExecView 闭合未找到');
const src = html.slice(start, endMarker + 2);

// ── 最小 DOM mock ──
function makeEl() {
  const el = {
    className: '', id: '', innerHTML: '', textContent: '', style: {},
    children: [], listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
    insertAdjacentElement(_pos, c) { this.children.push(c); return c; },
    classList: { set: new Set(), toggle(cls) { this.set.has(cls) ? this.set.delete(cls) : this.set.add(cls); return this.set.has(cls); }, add(c) { this.add?.(c); this.set.add(c); }, remove(c) { this.set.delete(c); } },
    querySelector() { return makeEl(); },
    parentElement: null,
  };
  el.parentElement = { querySelector: () => makeEl() };
  return el;
}
const makeExecView = (container) => new Function('container', '$', 'esc', 'document',
  `${src}; return makeExecView(container);`)
  (container, () => ({ scrollTop: 0, scrollHeight: 0 }), (s) => String(s), { createElement: () => makeEl() });

// ── 用例：完整事件序列（此前 finishLine 缺失在第一个 step 事件即崩）──
test('完整事件序列不抛错', () => {
  const v = makeExecView(makeEl());
  v.set('正在接收任务…');
  v.plan(['搜新闻', '总结']);
  v.step({ idx: 1, total: 2, goal: '搜新闻' });      // 此前此处 TypeError: this.finishLine is not a function
  v.stepDone({ goal: '搜新闻', output: '结果内容' }); // 折叠块
  v.step({ idx: 2, total: 2, goal: '总结' });         // 第二次 step：finishLine 真正被调用
  v.stepDone({ goal: '总结', output: '总结内容' });
  v.set('生成最终回答…');
  v.cur('综合回答');
  v.done();
  assert.ok(typeof v.html() === 'string');
});

test('stepDone 无当前行也不丢折叠块', () => {
  const v = makeExecView(makeEl());
  v.stepDone({ goal: 'x', output: 'y' }); // 无 step 在前：不抛错
  v.warn('警告文本');
  v.info('i', '信息文本');
});

test('finishLine 方法存在且可重复调用', () => {
  const v = makeExecView(makeEl());
  assert.equal(typeof v.finishLine, 'function');
  v.finishLine(); // 无行时 no-op
  v.plan(['a']);
  v.cur('行1');
  v.finishLine();
  v.finishLine(); // 幂等
});
