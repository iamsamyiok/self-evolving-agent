// tests/unit/ssrf.test.js —— SSRF 防线回归：私网段全表 + DNS 解析校验 + run_js 沙箱隔离
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicHost } from '../../core/tool-runtime.js';

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

test('assertPublicHost：回环域名被拦截，公网域名放行', async () => {
  await assert.rejects(() => assertPublicHost('localhost'), /私网|解析/);
  await assert.rejects(() => assertPublicHost('127.0.0.1'), /私网/);
  await assert.doesNotReject(() => assertPublicHost('open.er-api.com'));
});
