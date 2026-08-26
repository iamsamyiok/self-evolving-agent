// tests/unit/cli-lifecycle.test.js —— spa 命令生命周期：version 查询 / update 降级 / 未知命令 / 用法提示
// 密闭设计：SPA_NPM_REGISTRY 指向不可达端口，不依赖外网、绝不触发真实 npm install
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEAD_REGISTRY = 'http://127.0.0.1:9'; // discard 端口，连接即拒
const env = { ...process.env, SPA_NPM_REGISTRY: DEAD_REGISTRY };
const run = (args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'spa.js'), ...args], { encoding: 'utf8', env });
const runFail = (args) => { try { return { code: 0, out: run(args) }; } catch (e) { return { code: e.status, out: e.stdout ?? '' }; } };

test('spa version 输出版本号（registry 不可达时优雅降级）', () => {
  const out = run(['version']);
  assert.match(out, /self-evolve v\d+\.\d+\.\d+/);
  assert.match(out, /registry 不可达/);
});

test('spa --version 等价于 version', () => {
  assert.match(run(['--version']), /self-evolve v\d+\.\d+\.\d+/);
});

test('spa update 在 registry 不可达时退出码 1 并打印手动命令（绝不自动安装）', () => {
  const { code, out } = runFail(['update']);
  assert.equal(code, 1);
  assert.match(out, /npm i -g self-evolve@latest/);
});

test('未知命令退出码 1 且打印用法（含 version/update）', () => {
  const { code, out } = runFail(['__nope__']);
  assert.equal(code, 1);
  assert.match(out, /用法: spa/);
  assert.match(out, /version/);
  assert.match(out, /update/);
});
