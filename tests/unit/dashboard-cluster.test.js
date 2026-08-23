// tests/unit/dashboard-cluster.test.js —— 面板指标对账（§11.3 DoD：面板与 purge_logs 完全一致）+ 服务模式冒烟
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let Store, MonitorView;
let dir, store, dash;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spa-dash-'));
  process.env.SPA_DATA_DIR = dir;
  process.env.SPA_MOCK = '1';
  ({ Store } = await import('../../core/store-base.js'));
  ({ MonitorView } = await import('../../extend/monitor-view.js'));
  store = new Store(dir);
  dash = new MonitorView({ store, loop: null, purify: null, control: null });
});

test('面板指标与 purge_logs 对账：抽检全部一致（DoD §11.3-4）', async () => {
  // 写入若干净化日志
  store.logPurge({ epoch: 1, entityType: 'memory', entityId: 'm1', action: 'QUARANTINE', dimension: 'memory', reason: 'r1', evidence: {}, status: 'DONE' });
  store.logPurge({ epoch: 1, entityType: 'memory', entityId: 'm2', action: 'EXPIRE', dimension: 'memory', reason: 'r2', evidence: {}, status: 'DONE' });
  store.logPurge({ epoch: 1, entityType: 'memory', entityId: 'm3', action: 'RESTORE', dimension: 'memory', reason: 'r3', evidence: {}, status: 'DONE' });
  store.logPurge({ epoch: 2, entityType: 'skill', entityId: 's1', action: 'QUARANTINE', dimension: 'skill', reason: 'r4', evidence: {}, status: 'ROLLED_BACK' });

  const m = dash.metrics();
  // 对账：面板 QUARANTINE 计数 == purge_logs 中 DONE 的 QUARANTINE 数
  const expectedQuarantine = store.db.prepare("SELECT COUNT(*) AS n FROM purge_logs WHERE action = 'QUARANTINE' AND status = 'DONE'").get().n;
  assert.equal(m.purgeFunnel.QUARANTINE, expectedQuarantine, 'QUARANTINE 对账一致');
  assert.equal(m.purgeFunnel.RESTORE, 1);
  assert.equal(m.purgeFunnel.EXPIRE, 1);
  // ROLLED_BACK 不计入漏斗
  assert.equal(m.purgeFunnel.QUARANTINE, 1, 'rolled_back 不计入');
  // 任务对账
  assert.equal(m.taskSuccess.SUCCESS ?? 0, store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE outcome = 'SUCCESS'").get().n);
});

test('面板 HTTP 服务：/ 与 /api/metrics 可访问，SSE 挂载', async () => {
  const port = 3798 + Math.floor(Math.random() * 100);
  await dash.listen(port, async (input) => ({ outcome: 'SUCCESS', answer: `done:${input}` }));
  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.ok(html.includes('self-purify-agent'), '面板 HTML');
  const m = await fetch(`http://127.0.0.1:${port}/api/metrics`).then((r) => r.json());
  assert.ok(m.stats && m.purgeFunnel, 'metrics JSON');
  // 任务提交入口走正常调度
  const t = await fetch(`http://127.0.0.1:${port}/api/task`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '面板测试任务' }),
  }).then((r) => r.json());
  assert.equal(t.outcome, 'SUCCESS');
  dash.close();
});

test('集群协调者：spawn 2 个 MOCK worker，任务路由与结果回收（§9.3 冒烟）', { timeout: 30_000 }, async () => {
  const { ClusterCoordinator } = await import('../../extend/cluster.js');
  process.env.SPA_DATA_DIR = dir; // cluster 会用 DATA_DIR/worker-i
  const cluster = new ClusterCoordinator({ workers: 2, onLog: () => {} });
  try {
    await cluster.start();
    const st = cluster.status();
    assert.equal(st.workers.length, 2, '两个 worker');

    const r = await cluster.submitTask('集群测试任务：总结要点');
    assert.equal(r.outcome, 'SUCCESS', JSON.stringify(r));
    assert.ok(r.worker !== undefined, '结果带 worker 路由信息');
  } finally {
    cluster.stop();
    await new Promise((r2) => setTimeout(r2, 500)); // 等子进程退出信号送达
  }
});
