// tests/unit/ssrf.test.js —— SSRF 防线回归：私网段全表 + DNS 解析校验（SAFE_MODE 双模式）
// 全权限模式（默认）：confine/assertPublicHost/guardLookup 全放行（agent 可访问内网/全盘路径）
// SAFE_MODE=1：恢复囚禁与私网拦截
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicHost, guardLookup, ToolRuntime } from '../../core/tool-runtime.js';
import { CONFIG } from '../../config/index.js';

test('isPrivateIp：v4 私网/保留段全表拦截', () => {
  const blocked = ['127.0.0.1', '127.255.255.255', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1', '255.255.255.255'];
  for (const ip of blocked) assert.equal(isPrivateIp(ip), true, `${ip} 应判私网`);
});

test('isPrivateIp：v4 公网地址放行', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.128.0.1', '203.0.113.9', '110.242.68.66'];
  for (const ip of allowed) assert.equal(isPrivateIp(ip), false, `${ip} 应判公网`);
});

test('isPrivateIp：v6 回环/链路本地/ULA/映射拦截，全球单播放行', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判私网`);
  }
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateIp('2606:4700::1111'), false);
  assert.equal(isPrivateIp('not-an-ip'), true); // 非法格式一律拒绝
});

test('SAFE_MODE：assertPublicHost 拦截私网域名，放行公网域名', async () => {
  const prev = CONFIG.SAFE_MODE;
  CONFIG.SAFE_MODE = true;
  try {
    await assert.rejects(() => assertPublicHost('localhost'), /私网|解析/);
    await assert.rejects(() => assertPublicHost('127.0.0.1'), /私网/);
    await assert.doesNotReject(() => assertPublicHost('open.er-api.com'));
  } finally { CONFIG.SAFE_MODE = prev; }
});

test('全权限模式（默认）：assertPublicHost 放行本机域名', async () => {
  const prev = CONFIG.SAFE_MODE;
  CONFIG.SAFE_MODE = false;
  try {
    await assert.doesNotReject(() => assertPublicHost('localhost'));
    await assert.doesNotReject(() => assertPublicHost('127.0.0.1'));
  } finally { CONFIG.SAFE_MODE = prev; }
});

test('SAFE_MODE：guardLookup net all 形式返回过滤数组，私网全拒', async () => {
  const prev = CONFIG.SAFE_MODE;
  CONFIG.SAFE_MODE = true;
  try {
    await new Promise((done) => {
      guardLookup('localhost', { all: true, hints: 32 }, (err) => {
        assert.match(err.message, /私网|SAFE_MODE/);
        done();
      });
    });
    await new Promise((done, reject) => {
      guardLookup('open.er-api.com', { all: true }, (err, addrs) => {
        if (err) return reject(err);
        assert.ok(Array.isArray(addrs) && addrs.length >= 1);
        done();
      });
    });
    // 传统三参形式
    await new Promise((done, reject) => {
      guardLookup('open.er-api.com', {}, (err, address) => {
        if (err) return reject(err);
        assert.ok(typeof address === 'string');
        done();
      });
    });
  } finally { CONFIG.SAFE_MODE = prev; }
});

test('全权限模式：guardLookup 放行回环地址', async () => {
  const prev = CONFIG.SAFE_MODE;
  CONFIG.SAFE_MODE = false;
  try {
    await new Promise((done) => {
      guardLookup('localhost', { all: true }, (err, addrs) => {
        assert.equal(err, null);
        assert.ok(Array.isArray(addrs) && addrs.length >= 1);
        done();
      });
    });
  } finally { CONFIG.SAFE_MODE = prev; }
});

test('SAFE_MODE：http_get 拦私网 URL；全权限模式放行', async () => {
  const rt = new ToolRuntime(null, { workspace: '/tmp/any-ws' });
  const prev = CONFIG.SAFE_MODE;
  try {
    CONFIG.SAFE_MODE = true;
    const blocked = await rt.call('http_get', { url: 'http://127.0.0.1:1/x' }).catch((e) => ({ output: e.message }));
    assert.match(String(blocked.output ?? blocked), /私网/);
    CONFIG.SAFE_MODE = false;
    // 全权限：权限检查通过（连接失败是网络层结果，不再是 R5 拦截）
    const r2 = await rt.call('http_get', { url: 'http://127.0.0.1:1/x' }).catch((e) => ({ output: e.message }));
    assert.doesNotMatch(String(r2.output ?? r2), /R5|私网/);
  } finally { CONFIG.SAFE_MODE = prev; }
});

test('SAFE_MODE：fs_write 拒绝越出工作区路径；全权限模式放行', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'confine-'));
  const rt = new ToolRuntime(null, { workspace: join(dir, 'ws') });
  const outside = join(dir, 'outside.txt');
  const prev = CONFIG.SAFE_MODE;
  try {
    CONFIG.SAFE_MODE = true;
    const r1 = await rt.call('fs_write', { path: outside, content: 'x', use_reason: '测试路径囚禁' }).catch((e) => ({ output: e.message }));
    assert.match(String(r1.output ?? r1), /越出沙箱根/);
    CONFIG.SAFE_MODE = false;
    const r2 = await rt.call('fs_write', { path: outside, content: 'full-access', use_reason: '测试全盘写入' });
    assert.match(r2.output, /已写入/);
    assert.equal(readFileSync(outside, 'utf8'), 'full-access');
  } finally {
    CONFIG.SAFE_MODE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
