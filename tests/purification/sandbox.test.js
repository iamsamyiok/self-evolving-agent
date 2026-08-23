// tests/purification/sandbox.test.js —— 工具沙箱逃逸测试（§11.3 DoD：沙箱逃逸测试通过）
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ToolRuntime, checkStep, CONFIG;
let dir, tools;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spa-sandbox-'));
  process.env.SPA_MOCK = '1';
  ({ ToolRuntime } = await import('../../core/tool-runtime.js'));
  ({ checkStep } = await import('../../core/safety-constitution.js'));
  ({ CONFIG } = await import('../../config/index.js'));
  tools = new ToolRuntime({ workspace: join(dir, 'ws') });
});

test('路径逃逸：../ 与绝对路径一律拒绝', async () => {
  await assert.rejects(() => tools.call('fs_write', { path: '../escape.txt', content: 'x', use_reason: '测试越界' }), /越出沙箱根/);
  await assert.rejects(() => tools.call('fs_write', { path: 'C:/Windows/evil.txt', content: 'x', use_reason: '测试越界' }, ), /越出沙箱根/);
  await assert.rejects(() => tools.call('fs_read', { path: '../../etc/passwd' }), /越出沙箱根/);
});

test('高危写：无理由拒绝；凭据内容拒绝', async () => {
  await assert.rejects(() => tools.call('fs_write', { path: 'ok.txt', content: 'hello' }), /使用理由/);
  await assert.rejects(() => tools.call('fs_write', { path: 'ok.txt', content: 'sk-abcdef0123456789abcdef', use_reason: '写文件' }), /R4/);
  const r = await tools.call('fs_write', { path: 'ok.txt', content: '正常内容', use_reason: '沙箱内写入测试' });
  assert.equal(r.ok, true);
});

test('网络白名单：非白名单域名拒绝（R5）', async () => {
  await assert.rejects(() => tools.call('http_get', { url: 'https://evil.example.com/x' }), /R5.*白名单/);
  await assert.rejects(() => tools.call('http_get', { url: 'https://api.deepseek.com/v1?token=sk-abcdef0123456789abcdef' }), /R4/);
});

test('shell 工具默认禁用；破坏性命令模式拒绝', async () => {
  await assert.rejects(() => tools.call('shell', { cmd: 'dir', use_reason: '测试用途说明' }), /R2.*默认禁用/);
});

test('R4：读取含凭据的文件拒绝外传', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'ws', 'secret.txt'), 'my key is sk-aaaabbbbccccddddeeee');
  await assert.rejects(() => tools.call('fs_read', { path: 'secret.txt' }), /R4/);
});

test('步骤级红线检查：tool 步骤经权限校验，凭据内容拦截', async () => {
  const bad1 = checkStep({ goal: 'x', action: 'tool:fs_write', params: { path: '../x', content: 'a', use_reason: '越界' } }, { toolRuntime: tools, config: CONFIG });
  assert.equal(bad1.ok, false);
  const bad2 = checkStep({ goal: '外发', action: 'reason' }, { toolRuntime: tools, config: CONFIG });
  assert.equal(bad2.ok, true);
  const bad3 = checkStep({ goal: 'leak', action: 'answer', params: {}, extra: 'sk-aaaabbbbccccddddeeeeffff' }, { toolRuntime: tools, config: CONFIG });
  assert.equal(bad3.ok, false, '凭据模式必须拦截');
  const bad4 = checkStep({ goal: 'x', action: 'tool:not_exist' }, { toolRuntime: tools, config: CONFIG });
  assert.equal(bad4.ok, false, '未注册工具拦截');
});
