// tests/unit/fold-long-answer.test.js —— 长回答自动折叠（v1.8.0）：>10 行收起 + 展开/收起切换
// 从 chat.html 切出 applyFold 顶级源码，new Function + 桩 DOM 执行真实调用链（同 source-card-click 手法）。
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '../../web/chat.html'), 'utf8');
const foldLinesSrc = html.match(/const FOLD_LINES=\d+;/)?.[0] ?? 'const FOLD_LINES=10;';
const foldSrc = html.match(/function applyFold\([^)]*\)\{[\s\S]*?\n\}/)?.[0]
  ?? (() => { const s = html.indexOf('function applyFold('); const e = html.indexOf('\n}', s); return html.slice(s, e + 2); })();
assert.ok(foldSrc.includes('clamped'), 'applyFold 源码未切出（缺 clamped 逻辑）');

/** 桩 DOM：msg 元素内含 .bub；getComputedStyle 返回固定 line-height */
function makeScene({ scrollHeight, lineHeight = 27 }) {
  const inserted = [];
  const classes = new Set();
  const btnHandlers = [];
  const bub = {
    dataset: {},
    scrollHeight,
    classList: {
      add: (c) => classes.add(c),
      contains: (c) => classes.has(c),
      toggle(c) { const had = classes.has(c); had ? classes.delete(c) : classes.add(c); return !had; },
    },
    after: (el) => inserted.push(el),
    scrollIntoView: () => {},
  };
  const msgEl = { querySelector: (sel) => (sel === '.bub' ? bub : null) };
  // 按钮桩：onclick 可被赋值/触发
  const mkBtn = () => {
    const b = { className: '', textContent: '', onclick: null };
    return b;
  };
  // applyFold 内部用 document.createElement('span')
  const doc = { createElement: () => mkBtn() };
  const run = () => new Function('getComputedStyle', 'document', 'msgEl', foldLinesSrc + ';\n' + foldSrc + '; return applyFold(msgEl);')(
    (el) => ({ lineHeight: String(lineHeight) + 'px' }), doc, msgEl);
  return { bub, inserted, run, classes };
}

test('短回答（≤10 行）不折叠、无按钮', () => {
  const scene = makeScene({ scrollHeight: 27 * 5 });
  scene.run();
  assert.equal(scene.bub.classList.contains('clamped'), false);
  assert.equal(scene.inserted.length, 0);
});

test('长回答（40 行）自动折叠 + 展开按钮显示行数', () => {
  const scene = makeScene({ scrollHeight: 27 * 40 });
  scene.run();
  assert.equal(scene.bub.classList.contains('clamped'), true);
  assert.equal(scene.inserted.length, 1);
  const btn = scene.inserted[0];
  assert.match(btn.textContent, /展开全文（约 40 行）/);
  assert.equal(typeof btn.onclick, 'function');
});

test('按钮点击切换展开/收起', () => {
  const scene = makeScene({ scrollHeight: 27 * 25 });
  scene.run();
  const btn = scene.inserted[0];
  btn.onclick(); // 展开
  assert.equal(scene.bub.classList.contains('clamped'), false);
  assert.match(btn.textContent, /收起$/);
  assert.doesNotMatch(btn.textContent, /展开全文/);
  btn.onclick(); // 收起
  assert.equal(scene.bub.classList.contains('clamped'), true);
  assert.match(btn.textContent, /展开全文/);
});

test('幂等：同气泡二次调用不再加按钮', () => {
  const scene = makeScene({ scrollHeight: 27 * 40 });
  scene.run();
  scene.run(); // dataset.foldInited 已置位
  assert.equal(scene.inserted.length, 1);
});

test('chat.html 含折叠样式（clamped 渐变遮罩）与 FOLD_LINES=10', () => {
  assert.match(html, /\.bub\.clamped\{[^}]*max-height:18em/);
  assert.match(html, /\.bub\.clamped::after/);
  assert.match(html, /const FOLD_LINES=10/);
});
