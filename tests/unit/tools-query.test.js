// tests/unit/tools-query.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery } from '../../core/tools-query.js';

describe('tools-query', () => {
  test('JSON 点路径提取', () => {
    const data = { users: [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }] };
    const r = JSON.parse(runQuery({ source: JSON.stringify(data), path: 'users[0].name' }));
    assert.equal(r[0], 'Alice');
  });

  test('CSV-like where 筛选', () => {
    const data = [{ name: 'Alice', city: 'Beijing' }, { name: 'Bob', city: 'Shanghai' }];
    const r = JSON.parse(runQuery({ source: JSON.stringify(data), where: 'city==Beijing' }));
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'Alice');
  });

  test('contains 操作符', () => {
    const data = [{ tag: 'urgent-fix' }, { tag: 'low-priority' }];
    const r = JSON.parse(runQuery({ source: JSON.stringify(data), where: 'tag contains urgent' }));
    assert.equal(r.length, 1);
  });

  test('缺少 source 抛错', () => {
    assert.throws(() => runQuery({}), /source 必填/);
  });

  test('非法 JSON 抛错', () => {
    assert.throws(() => runQuery({ source: '{bad' }), /JSON 解析失败/);
  });
});
