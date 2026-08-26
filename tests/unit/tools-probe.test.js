// tests/unit/tools-probe.test.js
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runProbe } from '../../core/tools-probe.js';

describe('tools-probe', () => {
  let srv, port;
  beforeEach((t) => {
    srv = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>ok</p></body></html>');
    });
    return new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => { port = srv.address().port; resolve(); }); });
  });
  afterEach(() => srv.close());

  test('合法响应 + expect_status 通过', async () => {
    const r = JSON.parse(await runProbe({ url: `http://127.0.0.1:${port}/`, expect_status: 200 }));
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.checks[0].pass, true);
  });

  test('expect_contains 通过', async () => {
    const r = JSON.parse(await runProbe({ url: `http://127.0.0.1:${port}/`, expect_contains: 'Hello' }));
    assert.equal(r.ok, true);
    assert.equal(r.checks[0].pass, true);
  });

  test('expect_title 匹配', async () => {
    const r = JSON.parse(await runProbe({ url: `http://127.0.0.1:${port}/`, expect_title: 'Test Page' }));
    assert.equal(r.ok, true);
  });

  test('url 必填', async () => {
    await assert.rejects(() => runProbe({}), /url 必填/);
  });

  test('非法 URL 抛错', async () => {
    await assert.rejects(() => runProbe({ url: 'not-a-url' }), /无效 URL/);
  });
});
