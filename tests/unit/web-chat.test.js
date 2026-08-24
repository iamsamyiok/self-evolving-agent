// tests/unit/web-chat.test.js —— Web 对话界面：配置热生效 / 会话 CRUD / 流式对话 / 进化状态
import test from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let Store, AgentExecutor, PurifyCenter, AutoControl, EvolvePurifyLoop, WebServer, llm;
let dir, cfgPath, web, store;
let port;

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spa-web-'));
  process.env.SPA_DATA_DIR = join(dir, 'data');
  process.env.SPA_MOCK = '1';
  ({ Store } = await import('../../core/store-base.js'));
  ({ AgentExecutor } = await import('../../core/agent-executor.js'));
  ({ PurifyCenter } = await import('../../core/purify-center.js'));
  ({ AutoControl } = await import('../../core/auto-control.js'));
  ({ EvolvePurifyLoop } = await import('../../service/evolve-purify-loop.js'));
  ({ WebServer } = await import('../../web.js'));
  llm = await import('../../core/llm-adapter.js');
  store = new Store();
  const executor = new AgentExecutor(store);
  const purify = new PurifyCenter(store, executor);
  const control = new AutoControl(store);
  const loop = new EvolvePurifyLoop(executor, purify, control);
  cfgPath = join(dir, 'local.json');
  web = new WebServer({ store, executor, loop, control, configPath: cfgPath });
  port = 3850 + Math.floor(Math.random() * 100);
  await web.listen(port);
});

test.after(async () => {
  // 释放句柄：HTTP server 与 DB，避免进程挂起
  try { web?.close(); } catch { /* ignore */ }
  try { store?.close(); } catch { /* ignore */ }
});

async function readNdjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) events.push(JSON.parse(line));
    }
  }
  return events;
}

test('配置：保存即热生效（免重启）+ 落盘合并保留其他字段', async () => {
  // 预置一个无关字段，保存后必须保留
  const { writeFileSync } = await import('node:fs');
  writeFileSync(cfgPath, JSON.stringify({ OTHER_KEY: 42, LLM_API_KEY: 'sk-oldkey-keepme-000' }));
  const r = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'sk-newkey-abcd1234efgh5678' }),
  }).then((x) => x.json());
  assert.equal(r.model, 'test-model');
  assert.ok(r.apiKeyMasked.includes('***'));
  // 落盘检查
  const saved = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.equal(saved.OTHER_KEY, 42, '其他字段保留');
  assert.equal(saved.LLM_BASE_URL, 'https://example.com/v1');
  assert.ok(saved.LLM_API_KEY.startsWith('sk-newkey'));
  // 热生效：运行时立即用新配置
  const eff = llm.effectiveLLM();
  assert.equal(eff.model, 'test-model');
  assert.ok(eff.apiKey.startsWith('sk-newkey'));
});

test('配置：留空 Key 保留原值；测试连接走 MOCK', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'another-model' }),
  }).then((x) => x.json());
  const saved = JSON.parse(readFileSync(cfgPath, 'utf8'));
  assert.ok(saved.LLM_API_KEY.startsWith('sk-newkey'), 'Key 未被清空');
  const t = await fetch(`http://127.0.0.1:${port}/api/config/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  }).then((x) => x.json());
  assert.equal(t.ok, true);
  assert.equal(t.mock, true);
});

test('流式对话：conversation/stage/done 事件完整，消息落库，上下文注入可追溯', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '帮我总结 node:sqlite 的用法要点' }),
  });
  assert.equal(res.status, 200);
  const events = await readNdjson(res);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('conversation'), '有 conversation 事件');
  assert.ok(types.includes('stage'), '有 stage 事件');
  assert.ok(types.includes('done'), '有 done 事件');
  const conv = events.find((e) => e.type === 'conversation').conversation;
  assert.ok(conv.title.includes('node:sqlite'), '自动标题');

  const done = events.find((e) => e.type === 'done');
  assert.equal(done.message.meta.outcome, 'SUCCESS');
  assert.ok(done.message.content.length > 0, '有回答');
  assert.ok(done.message.meta.contextUsed, '上下文注入记录可追溯');
  assert.ok(typeof done.message.meta.durationMs === 'number');

  // 落库
  const msgs = await fetch(`http://127.0.0.1:${port}/api/conversations/${conv.id}/messages`).then((x) => x.json());
  assert.equal(msgs.length, 2, '一问一答');
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].meta.outcome, 'SUCCESS');

  // 会话列表
  const convs = await fetch(`http://127.0.0.1:${port}/api/conversations`).then((x) => x.json());
  assert.ok(convs.some((c) => c.id === conv.id));
});

test('多轮对话：第二轮携带上下文 + 进化钩子沉淀实体', async () => {
  const r1 = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '记住：我的项目用 Node 22 部署' }),
  });
  const ev1 = await readNdjson(r1);
  const convId = ev1.find((e) => e.type === 'conversation').conversation.id;
  await new Promise((r) => setTimeout(r, 250)); // 进化钩子异步落库

  const r2 = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: convId, content: '我刚才说用什么版本部署来着？', quick: true }),
  });
  const ev2 = await readNdjson(r2);
  const done = ev2.find((e) => e.type === 'done');
  assert.ok(done, '快速模式第二轮完成');
  assert.equal(done.message.meta.quick, true);

  // 进化沉淀确实发生（记忆/经验至少各 1）
  const s = await fetch(`http://127.0.0.1:${port}/api/state`).then((x) => x.json());
  assert.ok(s.entities.memory.count >= 1, '记忆已沉淀');
  assert.ok(s.entities.experience.count >= 1, '经验已沉淀');
  assert.ok(Array.isArray(s.tasks.last20), '成功率趋势数据');
  assert.ok(s.llm.configured, 'LLM 状态就绪');
});

test('进化状态：结构完整（净化漏斗/净利率/黄金集/调参）', async () => {
  const s = await fetch(`http://127.0.0.1:${port}/api/state`).then((x) => x.json());
  assert.ok(s.purify && typeof s.purify.funnel === 'object');
  assert.ok(Array.isArray(s.purify.netRateHistory));
  assert.ok(typeof s.golden === 'number');
  assert.ok(s.usage.budget > 0);
});

test('空消息 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '' }),
  });
  assert.equal(res.status, 400);
});

test('删除会话', async () => {
  const conv = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '待删除' }),
  }).then((x) => x.json());
  const del = await fetch(`http://127.0.0.1:${port}/api/conversations/${conv.id}`, { method: 'DELETE' }).then((x) => x.json());
  assert.equal(del.ok, true);
});
