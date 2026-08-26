// tests/unit/tools-usage.test.js —— usage 工具三层查询（get/history/budget）
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TMP = join(process.cwd(), '.tmp-usage-test');
let runUsage;
before(async () => {
  mkdirSync(TMP, { recursive: true });
  process.env.SPA_DATA_DIR = TMP; // 须在 import config 前设置（模块导入时定死 DATA_DIR）
  ({ runUsage } = await import('../../core/tools-usage.js'));
});

describe('tools-usage', () => {
  test('get：返回当日内存计数 + 日预算字段', () => {
    const r = JSON.parse(runUsage({ action: 'get' }));
    assert.equal(r.scope, 'day');
    assert.ok(typeof r.tokensIn === 'number');
    assert.ok(typeof r.dailyBudget === 'number');
  });

  test('get 带 label：返回标签维度计数', () => {
    const r = JSON.parse(runUsage({ action: 'get', label: 'planner' }));
    assert.equal(r.scope, 'label:planner');
    assert.ok(typeof r.calls === 'number');
  });

  test('budget：含 used/remaining/pctUsed 且口径一致', () => {
    const r = JSON.parse(runUsage({ action: 'budget' }));
    assert.ok(r.used >= 0);
    assert.ok(r.remaining >= 0);
    assert.ok(r.pctUsed >= 0 && r.pctUsed <= 1000);
    assert.equal(r.dailyBudget, r.used + r.remaining || r.dailyBudget >= r.used);
  });

  test('history：无文件时返回空历史', () => {
    const r = JSON.parse(runUsage({ action: 'history', days: 7 }));
    assert.equal(r.total, 0);
    assert.deepEqual(r.recent, []);
  });

  test('history：按 days 窗口过滤归档记录', () => {
    const today = new Date();
    const ago = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
    writeFileSync(join(TMP, 'inner-usage.json'), JSON.stringify({
      current: { day: ago(0), tokensIn: 100, tokensOut: 50, calls: 3, errors: 0 },
      byLabel: { planner: { tokensIn: 60, tokensOut: 20, calls: 2 } },
      history: [
        { day: ago(2), tokensIn: 1000, tokensOut: 500, calls: 20, errors: 1 },
        { day: ago(20), tokensIn: 9000, tokensOut: 9000, calls: 99, errors: 0 },
      ],
    }), 'utf8');
    const r = JSON.parse(runUsage({ action: 'history', days: 7 }));
    assert.equal(r.total, 1); // 20 天前的被过滤
    assert.equal(r.recent[0].tokensIn, 1000);
  });

  test('history 带 label：返回该标签当日累计', () => {
    const r = JSON.parse(runUsage({ action: 'history', label: 'planner' }));
    assert.equal(r.scope, 'current-day');
    assert.equal(r.tokensIn, 60);
    assert.equal(r.calls, 2);
  });

  test('未知 action 抛错', () => {
    assert.throws(() => runUsage({ action: 'bogus' }), /未知 action/);
  });
});

// 测试后清理（node:test 无 after-all 钩子在 describe 外；放在微任务里即可）
process.on('exit', () => { try { if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true }); } catch {} });
