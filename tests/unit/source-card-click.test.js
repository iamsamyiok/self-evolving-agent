// 来源卡片可点击性测试（v1.5.9）：整行可点 + openExternal 沙箱兜底链
// 从 chat.html 切出 esc/md/aiHtml/openExternal 顶级源码（同 exec-view 手法），new Function 执行真实调用链。
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '../../web/chat.html'), 'utf8');
function cut(startMarker, endStr) {
  const s = html.indexOf(startMarker);
  assert.ok(s > 0, `${startMarker} 未找到`);
  const e = html.indexOf(endStr, s);
  assert.ok(e > 0, `${startMarker} 闭合未找到`);
  return html.slice(s, e + endStr.length);
}
const escSrc = html.match(/const esc=[^\n]+/)[0];
const mdSrc = cut('function md(', '\n}');
const aiHtmlSrc = cut('function aiHtml(', '\n}');
const openExternalSrc = cut('function openExternal(', '\n}');

const aiHtml = (thinking, content, meta) =>
  new Function('md', 'a', 'b', 'c', `${escSrc}; ${aiHtmlSrc}; return aiHtml(a,b,c);`)(
    (s) => String(s ?? ''), thinking, content, meta);
// md 传桩即可——本测试只断言来源卡片结构，正文渲染归 md-autolink.test.js

const makeOpenExternal = ({ openResult = {}, topOk = true, promptCalls = [] } = {}) => {
  const fakeWindow = { open: () => openResult };
  if (topOk) fakeWindow._topLoc = { location: { set href(u) { fakeWindow._nav = u; } } };
  Object.defineProperty(fakeWindow, 'top', topOk
    ? { get: () => fakeWindow._topLoc }
    : { get() { throw new Error('cross-origin'); } });
  return {
    fn: (ev, url) => new Function('window', 'prompt', 'ev', 'url',
      `${openExternalSrc}; return openExternal(ev,url);`)(
      fakeWindow, (msg, u) => { promptCalls.push(u); return u; }, ev, url),
    window: fakeWindow,
  };
};
const mkEv = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

test('来源条目：整行带 click 类 + onclick openExternal（含 closest 守卫防双开）', () => {
  const out = aiHtml('', '回答正文', { evidence: [{ n: 1, title: '新闻 A', source: 'Example', url: 'https://example.com/a?x=1&y=2' }] });
  assert.ok(out.includes('src-item click'), '整行应带 click 类');
  assert.match(out, /onclick="if\(event\.target\.closest&&event\.target\.closest\('a'\)\)return;openExternal\(event,&quot;https:\/\/example\.com\/a\?x=1&amp;y=2&quot;\)"/, `实际：${out.match(/<div class="src-item[^>]*>/)?.[0]}`);
});

test('URL 缺 scheme：自动补 https:// 前缀', () => {
  const out = aiHtml('', '正文', { evidence: [{ n: 1, title: 'T', source: 'S', url: 'news.example.com/b' }] });
  assert.ok(out.includes('https://news.example.com/b'), 'href 与 onclick 都应是补全后的绝对 URL');
});

test('内层锚点：无 inline onclick（由全局委托处理，防重复打开）', () => {
  const out = aiHtml('', '正文', { evidence: [{ n: 1, title: 'T', source: 'S', url: 'https://e.com/x' }] });
  const anchor = out.match(/<a href="[^"]*" target="_blank" rel="noopener">[^<]*<\/a>/)?.[0];
  assert.ok(anchor, '锚点存在');
  assert.ok(!/onclick/.test(anchor), `锚点不应带 inline onclick：${anchor}`);
});

test('openExternal：window.open 可用 → 直接开新窗，不动顶层、不弹提示', () => {
  const { fn, window: w } = makeOpenExternal({ openResult: { closed: false } });
  const ev = mkEv();
  const r = fn(ev, 'https://e.com/x');
  assert.equal(r, false);
  assert.equal(ev.prevented, true);
  assert.equal(w._nav, undefined);
});

test('openExternal：弹窗被沙箱拦截 → 顶层窗口导航', () => {
  const prompts = [];
  const { fn, window: w } = makeOpenExternal({ openResult: null, topOk: true, promptCalls: prompts });
  fn(mkEv(), 'https://e.com/y');
  assert.equal(w._nav, 'https://e.com/y', '应尝试顶层导航');
  assert.equal(prompts.length, 0);
});

test('openExternal：弹窗与顶层都不可用 → prompt 给出可复制链接', () => {
  const prompts = [];
  const { fn } = makeOpenExternal({ openResult: null, topOk: false, promptCalls: prompts });
  fn(mkEv(), 'https://e.com/z');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0], 'https://e.com/z');
});

test('openExternal：非 http(s) 链接直接放行原生行为', () => {
  const { fn } = makeOpenExternal({ openResult: null });
  const ev = mkEv();
  fn(ev, 'javascript:alert(1)');
  assert.equal(ev.prevented, false, '内部/非外链不拦截默认行为');
});
