// tests/unit/tool-hardening.test.js —— 工具运行时加固三件套（A1 超时/截断/必填参数校验）
// + 锻造区 overlay（A2：覆盖/还原/热重载）+ 止损追踪器（A3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRuntime } from '../../core/tool-runtime.js';
import { makeStallTracker } from '../../core/agent-executor.js';

function makeRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'tool-hard-'));
  return { rt: new ToolRuntime(null, { workspace: join(dir, 'ws') }), dir };
}

test('A1 必填参数校验：缺参返回可重试错误（blocked 标记）', async () => {
  const { rt } = makeRuntime();
  await assert.rejects(
    () => rt.call('news_search', {}),
    (e) => e.blocked && /缺少必填参数/.test(e.message),
  );
  await assert.rejects(
    () => rt.call('fs_write', { path: 'x.txt' }),
    (e) => e.blocked && /content/.test(e.message),
  );
});

test('A1 执行超时兜底：挂起工具 60s 熔断（测试用 50ms 覆盖）', async () => {
  const { rt } = makeRuntime();
  const orig = ToolRuntime.TIMEOUT_MS;
  ToolRuntime.TIMEOUT_MS = 50;
  try {
    rt.register({
      name: 'hang_test', desc: '挂起测试', risk: 'low', requiredParams: [],
      checkPermissions: () => ({ ok: true }),
      run: () => new Promise(() => { /* 永不返回 */ }),
    });
    await assert.rejects(
      () => rt.call('hang_test', {}),
      (e) => e.timeout && /执行超时/.test(e.message),
    );
  } finally {
    ToolRuntime.TIMEOUT_MS = orig;
  }
});

test('A1 输出截断：超长输出截到 8k 并带截断标记', async () => {
  const { rt } = makeRuntime();
  rt.register({
    name: 'longout_test', desc: '超长输出', risk: 'low', requiredParams: [],
    checkPermissions: () => ({ ok: true }),
    run: async () => 'x'.repeat(20_000),
  });
  const r = await rt.call('longout_test', {});
  assert.ok(r.output.length <= ToolRuntime.OUTPUT_CAP + 30);
  assert.match(r.output, /输出过长已截断/);
});

test('A3 止损追踪器：连续失败 3 次触发，成功清零，reason 步骤不受影响', () => {
  const st = makeStallTracker(3);
  st.note('tool:news_search', false);
  st.note('tool:news_search', false);
  assert.equal(st.stalled('tool:news_search'), false); // 2 次未达阈值
  st.note('tool:news_search', false);
  assert.equal(st.stalled('tool:news_search'), true); // 3 次触发
  assert.equal(st.stalled('tool:calc'), false); // 其他工具不受影响
  assert.equal(st.stalled('reason'), false); // reason 步骤不参与
  st.note('tool:news_search', true);
  assert.equal(st.stalled('tool:news_search'), false); // 成功即清零
});

test('A2 锻造区 overlay：锻造版覆盖内置，restore 回滚内置版', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-'));
  const forgeDir = join(dir, 'tools-forged');
  mkdirSync(forgeDir, { recursive: true });
  process.env.SPA_FORGE_DIR = forgeDir;
  const { loadDynamicTools, writeForgedTool, readToolCode, deleteForgedTool, restoreTool, listOverlayTools } = await import('../../core/dynamic-tool-loader.js');
  // 前置：确保干净加载（模块级缓存 mtimeCache 用文件 mtime，无碍）
  const { rt } = (() => {
    const r = new ToolRuntime(null, { workspace: join(dir, 'ws') });
    return { rt: r };
  })();
  const names = await loadDynamicTools(rt);
  assert.ok(names.includes('calc')); // 内置 calc 被加载
  const builtin = rt.call('calc', { expr: '2+3' }).then((r) => r.output);
  assert.match(await builtin, /5/);
  // 锻造覆盖：同名 calc 返回固定值
  writeForgedTool('calc', `export default { name: 'calc', desc: '锻造版计算器', risk: 'low', requiredParams: ['expr'], checkPermissions: () => ({ ok: true }), run: async () => 'FORGED=42' };`);
  await loadDynamicTools(rt); // 重新扫描（mtime 已变）
  const r2 = await rt.call('calc', { expr: '2+3' });
  assert.match(r2.output, /FORGED=42/);
  // 源码读取走锻造区
  assert.match(readToolCode('calc'), /FORGED=42/);
  // 还原：删锻造版 → 内置版生效
  const res = await restoreTool(rt, 'calc');
  assert.equal(res.restored, true);
  const r3 = await rt.call('calc', { expr: '2+3' });
  assert.match(r3.output, /5/);
  // 清单标记 source
  const list = listOverlayTools(rt);
  assert.equal(list.find((t) => t.name === 'calc')?.source, 'builtin');
  deleteForgedTool('calc');
  delete process.env.SPA_FORGE_DIR;
});
