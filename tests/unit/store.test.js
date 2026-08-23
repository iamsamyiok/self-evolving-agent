// tests/unit/store.test.js —— 状态机 / 乐观锁 / 快照 / runExclusive 互斥
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let Store, uuid7, runExclusive;
let dir;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spa-store-'));
  process.env.SPA_DATA_DIR = dir;
  process.env.SPA_MOCK = '1';
  ({ Store, uuid7, runExclusive } = await import('../../core/store-base.js'));
});

function newStore() { return new Store(dir); }

function memRow(extra = {}) {
  const now = Date.now();
  return {
    id: uuid7(), state: 'ACTIVE', version: 1, parent_id: null, origin: 'evolve',
    created_at: now, updated_at: now, immunity_until: now, execution_count: 0, quality_score: 0.5,
    embedding: null, quarantined_at: null, purge_after: null, last_used_at: now,
    tier: 'short', kind: 'semantic', content: '测试记忆', importance: 0.5, access_count: 0,
    expires_at: null, supersede_of: null, entities: null, task_id: null, ...extra,
  };
}

test('状态机：合法迁移通过，非法迁移抛错（禁自造状态）', () => {
  const s = newStore();
  const id = s.insert('memory', memRow());
  s.transition('memory', id, 'QUARANTINED', { quarantined_at: Date.now() });
  s.transition('memory', id, 'PURGED');
  // 非法：PURGED 是终态；ACTIVE→PURGED 跳过隔离区
  assert.throws(() => s.transition('memory', id, 'ACTIVE'));
  const id2 = s.insert('memory', memRow());
  assert.throws(() => s.transition('memory', id2, 'PURGED'), /非法状态迁移/);
  // 技能：DRAFT 必须经验证晋升
  const sk = { id: uuid7(), state: 'DRAFT', version: 1, parent_id: null, origin: 'evolve', created_at: Date.now(), updated_at: Date.now(), immunity_until: Date.now(), execution_count: 0, quality_score: 0.5, embedding: null, quarantined_at: null, purge_after: null, last_used_at: null, name: 't_skill', scenario: 'x', description: 'x', steps: '[]', params_schema: null, success_count: 0, fail_count: 0, verified: 0, heat: 'warm' };
  const sid = s.insert('skill', sk);
  assert.throws(() => s.transition('skill', sid, 'QUARANTINED'), /非法状态迁移/);
  s.transition('skill', sid, 'ACTIVE');
  s.close();
});

test('乐观锁：过期版本写入被拒', () => {
  const s = newStore();
  const id = s.insert('memory', memRow());
  const v1 = s.get('memory', id).version;
  s.update('memory', id, { content: '改一' }); // version → 2
  assert.throws(() => s.update('memory', id, { content: '改二' }, v1), /乐观锁冲突/);
  assert.equal(s.get('memory', id).content, '改一');
  s.close();
});

test('快照：VACUUM INTO + SHA-256 登记 + 滚动保留', () => {
  const s = newStore();
  const snap = s.snapshot('test');
  assert.ok(existsSync(snap.file));
  assert.equal(snap.sha256.length, 64);
  assert.ok(s.snapshots().length >= 1);
  s.close();
});

test('runExclusive：同 key 串行执行', async () => {
  const order = [];
  await Promise.all([
    runExclusive('k1', async () => { await sleep(20); order.push('a'); }),
    runExclusive('k1', async () => { order.push('b'); }),
    runExclusive('k2', async () => { order.push('c'); }),
  ]);
  assert.deepEqual(order, ['c', 'a', 'b']); // k2 无竞争先过；k1 内 a 先于 b
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
