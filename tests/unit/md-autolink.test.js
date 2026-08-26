// md() 自动链接测试：来源必须可点击直达原始信息源（v1.5.8）
// 从 chat.html 切出 esc+md 顶级源码（同 exec-view.test.js 手法），new Function 注入执行真实调用链。
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dirname, '../../web/chat.html'), 'utf8');
const escSrc = html.match(/const esc=[^\n]+/)?.[0];
assert.ok(escSrc, 'esc 未找到');
const start = html.indexOf('function md(');
assert.ok(start > 0, 'md 未找到');
const end = html.indexOf('\n}', start);
assert.ok(end > 0, 'md 闭合未找到');
const mdSrc = html.slice(start, end + 2);

const md = (s) => new Function('s', `${escSrc}; ${mdSrc}; return md(s);`)(s);

test('裸 URL → 可点击链接（新标签 + noopener）', () => {
  const out = md('详见 https://example.com/report');
  assert.ok(out.includes('<a href="https://example.com/report"'), `应生成 a 标签：${out}`);
  assert.ok(out.includes('target="_blank"'));
  assert.ok(out.includes('rel="noopener"'));
});

test('"链接：URL" 行可点击（news_search 正文格式）', () => {
  const out = md('1. 某新闻标题\n   来源：Example\n   链接：https://news.example.com/a?x=1&y=2');
  assert.ok(out.includes('<a href="https://news.example.com/a?x=1&amp;y=2"'), `转义后 & 须保持 &amp;：${out}`);
});

test('代码块内 URL 不被链接化', () => {
  const out = md('说明\n```\ncurl https://api.example.com/v1\n```\n结束');
  assert.ok(out.includes('<pre>curl https://api.example.com/v1</pre>'), `pre 内 URL 须原样：${out}`);
  assert.ok(!/<a href="https:\/\/api\.example/.test(out), '代码块内不得生成 a 标签');
});

test('行内代码内 URL 不被链接化', () => {
  const out = md('用 `https://c.example.com/x` 端点');
  assert.ok(out.includes('<code>https://c.example.com/x</code>'));
  assert.ok(!/<a href="https:\/\/c\.example/.test(out));
});

test('markdown 链接语法 [文本](URL) → 文本可点', () => {
  const out = md('参考 [官方公告](https://example.com/ann/1) 了解详情');
  assert.ok(out.includes('<a href="https://example.com/ann/1" target="_blank" rel="noopener">官方公告</a>'), `实际：${out}`);
  assert.ok(!out.includes('[官方公告]'), '原语法标记应被消费');
});

test('长 URL 显示截断但 href 完整', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(100);
  const out = md(`来源 ${longUrl}`);
  assert.ok(out.includes(`href="${longUrl}"`), 'href 保留完整 URL');
  assert.ok(out.includes('…</a>'), '超长显示文本应截断带省略号');
});

test('无 URL 文本格式不受影响', () => {
  const out = md('**加粗**\n## 标题\n- 列表项');
  assert.ok(out.includes('<b>加粗</b>'));
  assert.ok(out.includes('<b style="font-size:15px">标题</b>'));
  assert.ok(out.includes('&bull; 列表项'));
});

test('纯文本中的 & 转义仍生效（无 URL 场景）', () => {
  const out = md('A & B <tag>');
  assert.ok(out.includes('A &amp; B &lt;tag&gt;'));
});
