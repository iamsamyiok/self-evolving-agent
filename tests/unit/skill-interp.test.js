import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

let Store, AgentExecutor;

before(async () => {
  ({ Store } = await import('../../core/store-base.js'));
  ({ AgentExecutor } = await import('../../core/agent-executor.js'));
});

after(() => { try { store?.close(); } catch {} });

let store;

test('interpolateParams：{{key}} 与 {key} 占位符替换', () => {
  store = new Store('/tmp/evo-test-' + randomUUID() + '.db');
  const ex = new AgentExecutor(store);
  const out = ex.interpolateParams(
    { url: 'https://wttr.in/{city}?format=j1', q: '天气 {{city}} 今天', n: 3, extra: { deep: '{city}' } },
    { city: '东京' },
  );
  assert.equal(out.url, 'https://wttr.in/东京?format=j1');
  assert.equal(out.q, '天气 东京 今天');
  assert.equal(out.n, 3);
  assert.equal(out.extra.deep, '东京');
});

test('interpolateParams：无对应变量时保留占位符原样', () => {
  store = new Store('/tmp/evo-test-' + randomUUID() + '.db');
  const ex = new AgentExecutor(store);
  const out = ex.interpolateParams({ url: 'https://x.com/{unknown}' }, { city: '东京' });
  assert.equal(out.url, 'https://x.com/{unknown}');
});

test('executeSkillStep：工具子步骤参数经用户参数插值', async () => {
  store = new Store('/tmp/evo-test-' + randomUUID() + '.db');
  const ex = new AgentExecutor(store);
  // 注册探针工具记录实际收到的参数
  let seen = null;
  ex.tools.register({
    name: 'probe', desc: '探针', risk: 'low',
    checkPermissions: () => ({ ok: true }),
    run: async (p) => { seen = p; return 'ok'; },
  });
  store.db.prepare(`INSERT INTO skills (id, name, state, scenario, description, steps, origin, created_at, updated_at, immunity_until) VALUES (?, ?, 'ACTIVE', '测试场景', '测试技能', ?, 'test', 0, 0, 0)`)
    .run('t-skill-1', 'probe_skill', JSON.stringify([
      { goal: '取数据', action: 'tool:probe', params: { url: 'https://wttr.in/{city}?format=j1', mode: 'fast' } },
    ]));
  const out = JSON.parse(await ex.executeSkillStep('probe_skill', { city: '东京' }, 't1'));
  assert.equal(seen.url, 'https://wttr.in/东京?format=j1');
  assert.equal(seen.mode, 'fast');
  assert.equal(out[0].output, 'ok');
});

test('executeSkillStep：用户参数覆盖技能硬编码默认值', async () => {
  store = new Store('/tmp/evo-test-' + randomUUID() + '.db');
  const ex = new AgentExecutor(store);
  let seen = null;
  ex.tools.register({
    name: 'probe2', desc: '探针2', risk: 'low',
    checkPermissions: () => ({ ok: true }),
    run: async (p) => { seen = p; return 'ok'; },
  });
  store.db.prepare(`INSERT INTO skills (id, name, state, scenario, description, steps, origin, created_at, updated_at, immunity_until) VALUES (?, ?, 'ACTIVE', '测试场景', '测试技能', ?, 'test', 0, 0, 0)`)
    .run('t-skill-2', 'probe_skill2', JSON.stringify([
      { goal: '取数据', action: 'tool:probe2', params: { url: 'https://x.com/{city_name}', city_name: '北京' } },
    ]));
  await ex.executeSkillStep('probe_skill2', { city_name: '上海' }, 't2');
  assert.equal(seen.url, 'https://x.com/上海');
});
