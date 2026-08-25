// tests/unit/skill-rollback.test.js —— 技能版本快照与污染回滚回归
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store } from '../../core/store-base.js';
import { SkillSystem } from '../../core/skill-system.js';

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'evo-rollback-'));
  const store = new Store(dir);
  return { store, dir };
}

function insertSkill(store, { name = 'test_skill', quality = 0.5, failStreak = 0, state = 'ACTIVE' }) {
  const id = `sk_${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  store.insert('skill', {
    id, state, version: 1, parent_id: null, origin: 'test',
    created_at: now, updated_at: now, immunity_until: 0,
    execution_count: 5, quality_score: quality, embedding: null,
    quarantined_at: null, purge_after: null, last_used_at: now,
    name, scenario: '测试场景', description: '测试描述', steps: '[]',
    params_schema: null, success_count: 2, fail_count: 3, verified: 1, heat: 'warm',
  });
  return id;
}

test('migrateV4：skill_versions 表与 tasks.status 列存在', () => {
  const { store, dir } = freshStore();
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  assert.ok(tables.includes('skill_versions'));
  const cols = store.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  assert.ok(cols.includes('status'));
  store.close(); rmSync(dir, { recursive: true, force: true });
});

test('markInterruptedTasks：running 行标记 interrupted，done 行不动', () => {
  const { store, dir } = freshStore();
  store.db.prepare("INSERT INTO tasks (id, input, outcome, outcome_basis, status, created_at) VALUES ('t1', 'x', 'PENDING', 'lifecycle', 'running', 1)").run();
  store.db.prepare("INSERT INTO tasks (id, input, outcome, outcome_basis, status, created_at) VALUES ('t2', 'y', 'SUCCESS', 'judge', 'done', 1)").run();
  const n = store.markInterruptedTasks();
  assert.equal(n, 1);
  const t1 = store.db.prepare("SELECT status, error FROM tasks WHERE id='t1'").get();
  assert.equal(t1.status, 'interrupted');
  assert.ok(t1.error.includes('中断'));
  assert.equal(store.db.prepare("SELECT status FROM tasks WHERE id='t2'").get().status, 'done');
  store.close(); rmSync(dir, { recursive: true, force: true });
});

test('snapshotSkill + tryRollback：更优历史版本恢复内容并重置计数', () => {
  const { store, dir } = freshStore();
  const skills = new SkillSystem(store, null);
  const id = insertSkill(store, { name: 'rb_skill', quality: 0.2, failStreak: 2 });
  // 手工注入一个优质历史版本（模拟晋升时刻快照）
  store.db.prepare(
    `INSERT INTO skill_versions (id, skill_id, version, name, scenario, description, steps, quality_score, success_count, fail_count, snapshot_at, reason)
     VALUES ('v1', ?, 1, 'rb_skill', '优质场景', '优质描述', '["step1"]', 0.85, 10, 1, 1, 'promoted_baseline')`
  ).run(id);

  const restored = skills.tryRollback(id);
  assert.equal(restored, 1);
  const s = store.get('skill', id);
  assert.equal(s.scenario, '优质场景');
  assert.equal(s.description, '优质描述');
  assert.equal(s.fail_streak, 0);
  assert.equal(s.execution_count, 0);
  assert.equal(s.state, 'ACTIVE'); // 回滚后回 ACTIVE 重新积累证据
  // 审计日志有 ROLLBACK 记录
  const log = store.db.prepare("SELECT action FROM purge_logs WHERE entity_id = ? AND action = 'ROLLBACK'").get(id);
  assert.ok(log, '应有 ROLLBACK 审计日志');
  store.close(); rmSync(dir, { recursive: true, force: true });
});

test('tryRollback：无显著更优版本时不回滚（返回 0）', () => {
  const { store, dir } = freshStore();
  const skills = new SkillSystem(store, null);
  const id = insertSkill(store, { name: 'rb_skill2', quality: 0.6 });
  store.db.prepare(
    `INSERT INTO skill_versions (id, skill_id, version, name, scenario, description, steps, quality_score, success_count, fail_count, snapshot_at, reason)
     VALUES ('v1', ?, 1, 'rb_skill2', 's', 'd', '[]', 0.65, 5, 2, 1, 'test')`
  ).run(id); // ΔQ=0.05 < 0.15 不触发
  assert.equal(skills.tryRollback(id), 0);
  store.close(); rmSync(dir, { recursive: true, force: true });
});

test('recordExecution：高质量技能 2 连败触发快照（Wilson 未跌破时）', () => {
  const { store, dir } = freshStore();
  const skills = new SkillSystem(store, null);
  const id = insertSkill(store, { name: 'cool_skill', quality: 0.9 });
  store.bumpStats('skill', id, { success_count: 20, fail_count: 1, execution_count: 21 }); // 高成功率：2 连败后 Wilson 仍在 promote 线上
  skills.recordExecution(id, false);
  assert.equal(store.get('skill', id).state, 'ACTIVE'); // 单次失败不熔断
  skills.recordExecution(id, false); // 第 2 次失败 → 快速熔断（先快照）
  const s = store.get('skill', id);
  assert.equal(s.state, 'COOLING');
  const snaps = skills.versions(id);
  assert.equal(snaps.length, 1); // 熔断前已留存证据快照
  assert.equal(snaps[0].reason, 'streak_cooling');
  store.close(); rmSync(dir, { recursive: true, force: true });
});
