// tests/unit/trusted-exec.test.js —— run_js 受信执行模式（全功能）+ open_url 跨平台打开
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import runJsTool from '../../tools/run_js.js';
import openUrlTool from '../../tools/open_url.js';

const dir = mkdtempSync(join(tmpdir(), 'trusted-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('run_js 可 require Node 内置模块（os/child_process 全开放）', async () => {
  const out = await runJsTool.run({ code: "const os=require('node:os'); const cp=require('child_process'); console.log(os.platform(), typeof cp.exec)" });
  assert.match(out, /linux|darwin|win32/);
  assert.match(out, /function/);
});

test('run_js 第三方包明确拒绝（零依赖边界）', async () => {
  const out = await runJsTool.run({ code: "require('lodash')" });
  assert.match(out, /只允许 require Node 内置模块/);
  assert.match(out, /lodash/);
});

test('run_js process 安全子集：platform 可用、exit 不可用（防误杀宿主）', async () => {
  const out = await runJsTool.run({ code: "console.log(typeof process.exit, process.platform)" });
  assert.match(out, /undefined/);
  assert.match(out, /linux|darwin|win32/);
});

test('run_js fs 真实读写（受信模式核心能力）', async () => {
  const target = join(dir, 'rt.txt');
  const out = await runJsTool.run({ code: `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(target)},'ok-trusted'); console.log(fs.readFileSync(${JSON.stringify(target)},'utf8'))` });
  assert.match(out, /ok-trusted/);
});

test('run_js 尾表达式返回值语义保留', async () => {
  const out = await runJsTool.run({ code: 'const a=21; a*2' });
  assert.match(out, /返回值：42/);
});

test('run_js top-level await 可用', async () => {
  const out = await runJsTool.run({ code: 'const v = await Promise.resolve(42); console.log("tla", v)' });
  assert.match(out, /tla 42/);
});

test('run_js timeoutMs 参数校验（1000-60000）', () => {
  assert.equal(runJsTool.checkPermissions({ code: '1', timeoutMs: 500 }).ok, false);
  assert.equal(runJsTool.checkPermissions({ code: '1', timeoutMs: 999999 }).ok, false);
  assert.equal(runJsTool.checkPermissions({ code: '1', timeoutMs: 15000 }).ok, true);
});

test('run_js 逃逸黑名单已移除（require/child_process 字样通过权限检查）', () => {
  const perm = runJsTool.checkPermissions({ code: "const cp=require('node:child_process'); cp.exec('echo hi')" });
  assert.equal(perm.ok, true);
});

test('open_url 拒绝非 http(s) 协议与相对路径', () => {
  assert.equal(openUrlTool.checkPermissions({ url: 'javascript:alert(1)' }).ok, false);
  assert.equal(openUrlTool.checkPermissions({ url: 'relative/path' }).ok, false);
  assert.equal(openUrlTool.checkPermissions({ url: 'https://example.com' }).ok, true);
  assert.equal(openUrlTool.checkPermissions({ url: '/abs/path.txt' }).ok, true);
});

test('open_url 无桌面环境优雅降级（返回诊断与替代方案，不算异常）', async () => {
  const out = await openUrlTool.run({ url: 'https://example.com' });
  // 本测试环境无浏览器启动器 → 降级建议；有桌面环境 → 已请求打开。两种都算走通
  assert.match(out, /没有可用的浏览器启动器|已请求系统浏览器打开|已发起打开请求/);
});

test('open_url 缺 url 参数被权限检查拦截', () => {
  assert.equal(openUrlTool.checkPermissions({}).ok, false);
});
