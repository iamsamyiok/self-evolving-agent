// tests/unit/subagent-context.test.js —— D1 预算压缩 + D2 并行子调研
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spa-d1d2-'));
  process.env.SPA_DATA_DIR = dir;
});
const big = 'x'.repeat(1200);

test('D1 compressStepsForBudget：未超预算原样；超预算折叠旧步骤、保最近3步与判定标记', async () => {
  const { compressStepsForBudget } = await import('../../core/research.js');
  // 未超预算
  const small = compressStepsForBudget([{ goal: 'a', output: '短' }]);
  assert.equal(small.compressed, false);
  // 超预算：6 步大产出，第 2 步带判定标记
  const steps = Array.from({ length: 6 }, (_, i) => ({ goal: `g${i}`, output: i === 1 ? `写入成功 ${big}` : big }));
  const r = compressStepsForBudget(steps, 3000);
  assert.equal(r.compressed, true);
  assert.match(r.steps[0].output, /已折叠/); // 最旧被折叠
  assert.match(r.steps[0].output, /上下文预算/);
  assert.equal(r.steps[1].output.includes('写入成功'), true); // 判定标记全文保留
  assert.equal(r.steps[1].output.includes('已折叠'), false);
  assert.equal(r.steps[5].output.includes('已折叠'), false); // 最近 3 步全文
  assert.equal(r.steps[4].output.includes('已折叠'), false);
  // 折叠后头尾保留
  assert.ok(r.steps[0].output.startsWith('xxx'));
  assert.ok(r.steps[0].output.endsWith('xxx'));
});

test('D2 parseTopics：数组/多分隔符/编号剥离/上限3', async () => {
  const { parseTopics } = await import('../../core/subagent.js');
  assert.deepEqual(parseTopics(['React 趋势', 'Vue 趋势']), ['React 趋势', 'Vue 趋势']);
  assert.deepEqual(parseTopics('调研 甲主题、乙主题，丙主题；丁主题'), ['调研 甲主题', '乙主题', '丙主题']); // 上限 3（单字符主题被长度闸门滤除）
  assert.deepEqual(parseTopics('1. 第一个课题、2. 第二个课题'), ['第一个课题', '第二个课题']); // 编号剥离
  assert.deepEqual(parseTopics('  , ， 、'), []);
  assert.deepEqual(parseTopics(null), []);
  assert.deepEqual(parseTopics(42), []);
});

test('D2 runSubagents：MOCK 下并行返回各子课题结论；空 topics 报错', async () => {
  const { CONFIG } = await import('../../config/index.js');
  CONFIG.MOCK = true;
  const { runSubagents, parseTopics } = await import('../../core/subagent.js');
  // 桩 executor：news_search 调用抛错 → 走"检索不可用"知识综合降级路径
  const executor = { tools: { call: async () => { throw new Error('MOCK 断网'); } } };
  const out = await runSubagents(executor, { topics: '固态电池进展、人形机器人量产' }, 't');
  assert.match(out, /【子课题 1】固态电池进展/);
  assert.match(out, /【子课题 2】人形机器人量产/);
  // 搜索失败降级：结论含未核实声明
  assert.match(out, /未经联网核实/);
  await assert.rejects(() => runSubagents(executor, { topics: '' }), /topics 为空/);
  CONFIG.MOCK = false;
});

test('D2 runSubagents：结论尾部附原始来源链接（可点击直达信息源）', async () => {
  const { CONFIG } = await import('../../config/index.js');
  CONFIG.MOCK = true;
  const { runSubagents } = await import('../../core/subagent.js');
  // 桩 executor：news_search 返回标准检索格式（含 URL）→ 结论尾部应附 来源：标题 URL
  const searchOut = {
    output: '1. 固态电池重大突破\n   来源：科技日报\n   链接：https://news.example.com/battery/1\n   摘要：能量密度提升\n\n2. 量产时间表\n   来源：路透社\n   链接：https://news.example.com/mass/2\n   摘要：2027 年',
  };
  const executor = { tools: { call: async () => searchOut } };
  const out = await runSubagents(executor, { topics: '固态电池进展' }, 't2');
  assert.match(out, /来源：/);
  assert.match(out, /https:\/\/news\.example\.com\/battery\/1/, '结论须携带原始 URL');
  assert.match(out, /https:\/\/news\.example\.com\/mass\/2/);
  CONFIG.MOCK = false;
});

test('D2 工具注册面：subagent 进工具清单，参数校验生效', async () => {
  const { ToolRuntime } = await import('../../core/tool-runtime.js');
  const rt = new ToolRuntime(null, { workspace: join(tmpdir(), 'ws-d2') });
  const tool = rt.get('subagent');
  assert.ok(tool, 'subagent 应随内置注册');
  assert.deepEqual(tool.requiredParams, ['topics']);
  // 未注入 runner：blocked
  await assert.rejects(() => rt.call('subagent', { topics: 'a、b' }), /子调研代理未注入/);
  // 注入 runner：调用通
  rt.setSubagentRunner(async (p) => `ran:${String(p.topics)}`);
  const r = await rt.call('subagent', { topics: 'a、b' });
  assert.match(r.output, /ran:a、b/);
  // 缺参：blocked
  await assert.rejects(() => rt.call('subagent', {}), /缺少必填参数/);
});
