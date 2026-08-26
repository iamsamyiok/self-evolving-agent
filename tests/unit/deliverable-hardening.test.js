// tests/unit/deliverable-hardening.test.js —— 交付链硬化：run_js 数值哨兵 / fs_write JSON 前置校验 / verify+todo 参数归一
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRuntime } from '../../core/tool-runtime.js';
import { pickDeliverableContent } from '../../core/agent-executor.js';
import runJsTool from '../../tools/run_js.js';

const dir = mkdtempSync(join(tmpdir(), 'deliverable-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('run_js 数值输出全 null 时附加健全性警告（NaN 被 JSON.stringify 序列化为 null）', async () => {
  const code = 'const plans=[{name:"个人版",price:19,users:8000}];let m=0;plans.forEach(p=>{m+=p.price*p.seats;});console.log(JSON.stringify({monthly_total:m},null,2));';
  const out = await runJsTool.run({ code });
  assert.match(out, /monthly_total/);
  assert.match(out, /null/);
  assert.match(out, /数值健全性警告/);
});

test('run_js 正常数值输出不触发警告', async () => {
  const out = await runJsTool.run({ code: 'console.log(JSON.stringify({monthly_total:152000}))' });
  assert.doesNotMatch(out, /数值健全性警告/);
});

test('fs_write 写非法 JSON 返回格式警告（写盘仍成功）', async () => {
  const rt = new ToolRuntime(null, { workspace: join(dir, 'ws') });
  const r = await rt.call('fs_write', { path: 'bad.json', content: '{"a":1,}', use_reason: '测试非法JSON' });
  assert.match(r.output, /已写入/);
  assert.match(r.output, /JSON 格式非法/);
});

test('fs_write 写合法 JSON 正常返回', async () => {
  const rt = new ToolRuntime(null, { workspace: join(dir, 'ws') });
  const r = await rt.call('fs_write', { path: 'ok.json', content: '{"a":1}', use_reason: '测试合法JSON' });
  assert.match(r.output, /已写入/);
  assert.doesNotMatch(r.output, /JSON 格式非法/);
});

test('normalizeParams: verify 的 path/file 归一到 file', () => {
  const p = ToolRuntime.normalizeParams('verify', { rules: [{ type: 'json_valid' }], path: 'x.json' });
  assert.equal(p.file, 'x.json');
});

test('normalizeParams: todo 的 task/title/content 归一到 text', () => {
  assert.equal(ToolRuntime.normalizeParams('todo', { action: 'add', task: 'T1' }).text, 'T1');
  assert.equal(ToolRuntime.normalizeParams('todo', { action: 'add', title: 'T2' }).text, 'T2');
  assert.equal(ToolRuntime.normalizeParams('todo', { action: 'add', text: 'T3' }).text, 'T3');
});

test('verify 经归一化后用 path 参数即可断言文件（真实回归 run4 场景）', async () => {
  const rt = new ToolRuntime(null, { workspace: join(dir, 'ws') });
  await rt.call('fs_write', { path: 'pricing.json', content: '{"monthly_total": 152000}', use_reason: '回归场景' });
  const r = await rt.call('verify', { rules: [{ type: 'json_valid' }, { type: 'file_exists', value: 'pricing.json' }], path: 'pricing.json' });
  const j = JSON.parse(r.output);
  assert.equal(j.passAll, true);
});

test('pickDeliverableContent：答案含匹配扩展名围栏块时只取块内内容', () => {
  const ans = '分析如下：\n```json\n{"monthly": 546500}\n```\n以上是结论。';
  assert.equal(pickDeliverableContent(ans, 'pricing-analysis.json'), '{"monthly": 546500}');
});

test('pickDeliverableContent：围栏语言与扩展名不匹配时取整篇答案', () => {
  const ans = '如下：\n```python\nprint(1)\n```\n结论完。';
  assert.equal(pickDeliverableContent(ans, 'out.json'), ans.trim());
});

test('pickDeliverableContent：无围栏块时整篇答案落盘', () => {
  const ans = '纯文本交付内容';
  assert.equal(pickDeliverableContent(ans, 'note.md'), '纯文本交付内容');
});
