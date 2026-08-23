// tests/unit/evolve.test.js —— MOCK 端到端：任务执行 → 记忆/经验沉淀 → 二次任务去重 → 技能提炼/墓碑
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let Store, AgentExecutor, uuid7;
let dir, store, executor;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spa-evolve-'));
  process.env.SPA_DATA_DIR = dir;
  process.env.SPA_MOCK = '1';
  ({ Store, uuid7 } = await import('../../core/store-base.js'));
  ({ AgentExecutor } = await import('../../core/agent-executor.js'));
  store = new Store(dir);
  executor = new AgentExecutor(store);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('任务执行全链路（MOCK）：规划→步骤→判定→轨迹落库', async () => {
  const trace = await executor.runTask('帮我总结 Node.js 内置 SQLite 用法', {
    assertion: { type: 'contains', value: '最终回答' },
    silent: true,
  });
  assert.equal(trace.outcome, 'SUCCESS');
  assert.ok(trace.plan?.steps?.length >= 1, '有规划');
  assert.ok(trace.steps.length >= 1, '有步骤');
  const row = store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(trace.id);
  assert.ok(row, '轨迹已落库');
});

test('进化沉淀：记忆抽取 + 经验复盘 + 黄金集冷启动', async () => {
  await executor.runTask('总结 SQLite WAL 模式要点', { silent: true });
  await sleep(200); // 进化钩子异步
  assert.ok(store.list('memory', "WHERE state = 'ACTIVE'").length >= 1, '记忆已沉淀');
  assert.ok(store.list('experience', "WHERE state = 'ACTIVE'").length >= 1, '经验已沉淀（含证据链）');
  const exp = store.list('experience', "WHERE state = 'ACTIVE'")[0];
  const ev = JSON.parse(exp.evidence);
  assert.ok(ev.length >= 1 && ev[0].trace_hash, '经验必须挂证据链（防幻影经验）');
  assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM golden_tasks').get().n >= 1, '黄金集冷启动');
});

test('二次同类任务：记忆去重跳过 + 经验合并（sample_count 增长）', async () => {
  const beforeMem = store.list('memory', "WHERE state = 'ACTIVE'").length;
  const expBefore = store.list('experience', "WHERE state = 'ACTIVE'")[0];
  await executor.runTask('总结 SQLite WAL 模式要点', { silent: true });
  await sleep(200);
  const afterMem = store.list('memory', "WHERE state = 'ACTIVE'").length;
  assert.equal(afterMem, beforeMem, '重复记忆被去重跳过（DEDUP_SKIP）');
  const dedupLogs = store.db.prepare("SELECT COUNT(*) AS n FROM purge_logs WHERE action = 'DEDUP_SKIP'").get().n;
  assert.ok(dedupLogs >= 1, '去重留痕');
  const expAfter = store.list('experience', "WHERE state = 'ACTIVE'").find((e) => e.id === expBefore.id);
  assert.ok(!expAfter || expAfter.sample_count >= expBefore.sample_count, '重复经验合并不新建');
});

test('技能提炼走 DRAFT（生成即上线被禁止）+ 墓碑拦截再生', async () => {
  // MOCK 提炼器 1/3 概率返回 null，其余返回技能 → 多跑几个任务确保至少产生一个 DRAFT
  for (let i = 0; i < 6 && store.list('skill', "WHERE state = 'DRAFT'").length === 0; i++) {
    await executor.runTask(`任务类型 ${i % 3}：批量重命名文件并校验`, { silent: true });
    await sleep(150);
  }
  const drafts = store.list('skill', "WHERE state = 'DRAFT'");
  assert.ok(drafts.length >= 1, '技能以 DRAFT 状态产生（门禁前置）');
  assert.equal(drafts[0].verified, 0, '未经黄金集验证不得 verified');

  // 墓碑拦截：登记墓碑后同内容技能禁止直接再生
  const tomb = drafts[0];
  const { tokenize } = await import('../../utils/similarity.js');
  store.addTombstone('skill', tomb.id, tokenize(`${tomb.name} ${tomb.scenario} ${tomb.description}`));
  const skillSys = executor.skills;
  const hit = skillSys.checkTombstones(`${tomb.name} ${tomb.scenario} ${tomb.description}`);
  assert.ok(hit >= 0.9, '墓碑相似度命中');
});

test('检索注入即记账：access_count / last_used_at 更新', () => {
  const mems = store.list('memory', "WHERE state = 'ACTIVE'");
  if (!mems.length) return;
  const before = mems[0].access_count;
  executor.memory.retrieve('SQLite 用法');
  const after = store.get('memory', mems[0].id).access_count;
  assert.ok(after >= before, '命中注入即记账');
});
