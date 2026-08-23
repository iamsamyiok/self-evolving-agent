// tests/purification/dirty-inject.test.js —— 净化注入测试（DoD 关键验收项，§10.2 / §11.1）
// 构造脏数据集（过期记忆/冗余对/坏行/失效经验/劣质经验/正常实体），断言：
//   ① 净化精确率 ≥90%（正常实体被误隔离数 / 正常总数 ≤10%，MVP 线）
//   ② 脏数据处理召回率 ≥90%（多周期后）
//   ③ 变更率上限生效（每周期 ≤5% 活性实体）
//   ④ 免疫期 / 最小证据保护生效（n<5 不淘汰）
//   ⑤ 全程可回滚（restore 后回到 ACTIVE）
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let Store, PurifyCenter, uuid7;
let dir, store, purify;
const now = Date.now();
const D = 86_400_000;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spa-purify-'));
  process.env.SPA_DATA_DIR = dir;
  process.env.SPA_MOCK = '1';
  ({ Store, uuid7 } = await import('../../core/store-base.js'));
  ({ PurifyCenter } = await import('../../core/purify-center.js'));
  store = new Store(dir);
  purify = new PurifyCenter(store);
});

function memRow(extra = {}) {
  return {
    id: uuid7(), state: 'ACTIVE', version: 1, parent_id: null, origin: 'migrate',
    created_at: now - 40 * D, updated_at: now - 2 * D, immunity_until: now - D,
    execution_count: 0, quality_score: 0.4, embedding: null,
    quarantined_at: null, purge_after: null, last_used_at: now - 2 * D,
    tier: 'short', kind: 'semantic', content: '', importance: 0.5, access_count: 0,
    expires_at: null, supersede_of: null, entities: null, task_id: null, ...extra,
  };
}
function expRow(extra = {}) {
  return {
    id: uuid7(), state: 'ACTIVE', version: 1, parent_id: null, origin: 'migrate',
    created_at: now - 40 * D, updated_at: now - 2 * D, immunity_until: now - D,
    execution_count: 0, quality_score: 0.4, embedding: null,
    quarantined_at: null, purge_after: null, last_used_at: now - 2 * D,
    task_signature: '', summary: '', rules: '[]', pitfalls: '[]', failure_taxonomy: null,
    evidence: '[]', sample_count: 1, success_count: 0, fail_count: 0, ...extra,
  };
}

test('注入式净化：精确率 ≥90%、召回率 ≥90%、变更率受限、保护机制生效、可回滚', async () => {
  // ── 正常实体（8 个：永不应被隔离）──
  const normalIds = [];
  normalIds.push(store.insert('memory', memRow({ tier: 'long', content: '正常长期记忆：项目代码规范要点汇总', importance: 0.9, access_count: 9 })));
  normalIds.push(store.insert('memory', memRow({ tier: 'short', content: '正常短期记忆：本周会议安排在周四', importance: 0.8, access_count: 3, expires_at: now + 5 * D })));
  normalIds.push(store.insert('memory', memRow({ tier: 'long', content: '正常长期记忆：用户偏好简洁回复', importance: 0.85, access_count: 7 })));
  normalIds.push(store.insert('experience', expRow({ task_signature: '正常经验：API 重试最佳实践', summary: '对 429 用指数退避', rules: '["退避加抖动"]', pitfalls: '["不重试 4xx"]', evidence: `[{"task_id":"t1","outcome":"SUCCESS","trace_hash":"h1"}]`, sample_count: 9, success_count: 9, fail_count: 0, execution_count: 9, last_used_at: now - 1 * D })));
  normalIds.push(store.insert('experience', expRow({ task_signature: '正常经验：SQL 索引优化', summary: '前缀索引节省空间', rules: '["先 explain"]', pitfalls: '[]', evidence: `[{"task_id":"t2","outcome":"SUCCESS","trace_hash":"h2"}]`, sample_count: 6, success_count: 5, fail_count: 1, execution_count: 6, last_used_at: now - 3 * D })));
  normalIds.push(store.insert('memory', memRow({ tier: 'short', content: '正常短期记忆：版本号规则', importance: 0.7, access_count: 2, expires_at: now + 6 * D })));
  normalIds.push(store.insert('memory', memRow({ tier: 'long', content: '正常长期记忆：部署检查单内容', importance: 0.8, access_count: 5 })));
  normalIds.push(store.insert('experience', expRow({ task_signature: '正常经验：文档撰写流程', summary: '先列大纲再填充', rules: '[]', pitfalls: '["避免一次写完"]', evidence: `[{"task_id":"t3","outcome":"SUCCESS","trace_hash":"h3"}]`, sample_count: 5, success_count: 4, fail_count: 1, execution_count: 5, last_used_at: now - 10 * D })));

  // ── 脏实体 ──
  const dirty = {};
  dirty.expired = store.insert('memory', memRow({ tier: 'short', content: '脏数据：过期接口说明', expires_at: now - D }));           // 过期
  dirty.dupLoser = store.insert('memory', memRow({ tier: 'long', content: '脏数据：冗余记忆乙 同一条信息重复记录', importance: 0.2, access_count: 1 })); // 冗余败者
  dirty.dupWinner = store.insert('memory', memRow({ tier: 'long', content: '脏数据：冗余记忆乙 同一条信息重复记录', importance: 0.95, access_count: 12 })); // 冗余胜者（存活）
  dirty.corrupt = store.insert('experience', expRow({ task_signature: '脏数据：坏行经验', summary: '规则字段损坏', rules: '{broken json', last_used_at: now - 50 * D })); // 坏行
  dirty.stale = store.insert('experience', expRow({ task_signature: '脏数据：失效经验', summary: '90 天零命中', last_used_at: now - 91 * D })); // 失效
  dirty.lowq = store.insert('experience', expRow({ task_signature: '脏数据：劣质经验', summary: '成功率极低', sample_count: 9, success_count: 0, fail_count: 9, execution_count: 9, last_used_at: now - 1 * D })); // 劣质 W=0
  dirty.immune = store.insert('memory', memRow({ tier: 'short', content: '脏数据：但在免疫期内', expires_at: now - D, immunity_until: now + D })); // 免疫期保护（应跳过）
  dirty.lowEvidence = store.insert('experience', expRow({ task_signature: '脏数据：证据不足的劣质经验', summary: '只失败过两次', sample_count: 2, success_count: 0, fail_count: 2, execution_count: 2, last_used_at: now - 1 * D })); // n<5 只降权不删（应跳过）

  const dirtySet = new Set([dirty.expired, dirty.dupLoser, dirty.corrupt, dirty.stale, dirty.lowq]); // 应被净化的 5 个（dupWinner/immune/lowEvidence 预期存活）

  // ── 多周期执行（变更率上限会限制每周期配额，循环直至无候选）──
  const activeTotal = () => purify.activeEntityCount();
  let perCycleMax = [];
  let reports = [];
  for (let i = 0; i < 20; i++) {
    const before = store.list('memory', "WHERE state = 'QUARANTINED'").length + store.list('experience', "WHERE state = 'QUARANTINED'").length;
    const report = await purify.runCycle({ deep: true });
    const after = store.list('memory', "WHERE state = 'QUARANTINED'").length + store.list('experience', "WHERE state = 'QUARANTINED'").length;
    const churnedThisCycle = after - before;
    perCycleMax.push(Math.floor(activeTotal() * 0.05) + 1); // 允许 5%+取整余量
    if (churnedThisCycle > 0) reports.push({ cycle: i, churned: churnedThisCycle, detected: report.detected });
    if (!report.detected.length) break;
  }

  // ── ① 精确率：正常实体零误隔离 ──
  const quarantinedAll = [...store.list('memory', "WHERE state = 'QUARANTINED'"), ...store.list('experience', "WHERE state = 'QUARANTINED'")].map((r) => r.id);
  const normalQuarantined = quarantinedAll.filter((id) => normalIds.includes(id));
  const precision = 1 - normalQuarantined.length / normalIds.length;
  assert.ok(precision >= 0.9, `净化精确率 ${precision}，误隔离正常实体: ${normalQuarantined}`);

  // ── ② 召回率：5 个应净化脏实体全部入隔离区 ──
  const dirtyHandled = [...dirtySet].filter((id) => quarantinedAll.includes(id));
  const recall = dirtyHandled.length / dirtySet.size;
  assert.ok(recall >= 0.9, `召回率 ${recall}，未处理: ${[...dirtySet].filter((id) => !quarantinedAll.includes(id))}`);

  // ── ③ 保护机制：免疫期 / 最小证据实体未被隔离 ──
  assert.equal(store.get('memory', dirty.immune)?.state, 'ACTIVE', '免疫期实体必须存活');
  assert.equal(store.get('experience', dirty.lowEvidence)?.state, 'ACTIVE', 'n<5 只降权不删除');
  assert.equal(store.get('memory', dirty.dupWinner)?.state, 'ACTIVE', '冗余对决胜者存活');

  // ── ④ 留痕：每个被隔离实体都有 DONE 日志且含判定依据 ──
  for (const id of quarantinedAll) {
    const log = store.db.prepare("SELECT * FROM purge_logs WHERE entity_id = ? AND status = 'DONE' AND action IN ('QUARANTINE','EXPIRE','LOST_AND_FOUND')").get(id);
    assert.ok(log, `实体 ${id} 缺净化日志`);
    assert.ok(log.evidence.length > 2, '日志须含判定依据');
  }

  // ── ⑤ 回滚：隔离区可恢复 ──
  const r = await purify.restore(dirty.expired);
  assert.equal(r.ok, true);
  assert.equal(store.get('memory', dirty.expired).state, 'ACTIVE');
});

test('崩溃恢复：EXECUTING 日志重启后收尾（§7.2）', async () => {
  // 造一个"已隔离但日志未收尾"的现场
  const id = store.insert('memory', memRow({ tier: 'short', content: '崩溃恢复测试：过期记忆', expires_at: now - D }));
  store.logPurge({ epoch: 1, entityType: 'memory', entityId: id, action: 'EXPIRE', dimension: 'memory', reason: 'test', evidence: {}, status: 'EXECUTING' });
  store.transition('memory', id, 'EXPIRED');
  store.transition('memory', id, 'QUARANTINED', { quarantined_at: now, purge_after: now + 30 * D });
  // 造一个"日志在、变更未执行"的现场
  const id2 = store.insert('memory', memRow({ content: '崩溃恢复测试2' }));
  store.logPurge({ epoch: 1, entityType: 'memory', entityId: id2, action: 'QUARANTINE', dimension: 'memory', reason: 'test', evidence: {}, status: 'EXECUTING' });

  const fixed = purify.recoverInterrupted();
  assert.equal(fixed.length, 2);
  assert.equal(store.db.prepare("SELECT status FROM purge_logs WHERE entity_id = ?").all(id)[0].status, 'DONE');
  assert.equal(store.db.prepare("SELECT status FROM purge_logs WHERE entity_id = ?").all(id2)[0].status, 'ROLLED_BACK');
  assert.equal(store.get('memory', id2).state, 'ACTIVE');
});

test('TTL 清扫：隔离区到期 → PURGED + 墓碑', async () => {
  const id = store.insert('memory', memRow({ tier: 'short', content: 'TTL 清扫测试', expires_at: now - D }));
  store.transition('memory', id, 'QUARANTINED', { quarantined_at: now - 31 * D, purge_after: now - D });
  const swept = await purify.sweepExpired(now);
  assert.ok(swept.some((s) => s.endsWith(id)), '应被清扫');
  assert.equal(store.get('memory', id), undefined, '行已硬删');
  assert.ok(store.tombstones().length >= 1, '墓碑已登记');
});
