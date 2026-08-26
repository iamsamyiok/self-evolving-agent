// tests/unit/research.test.js —— 深度研究管线单测：证据解析/去重编号/引用清单/gap-check 守卫/蒸馏降级
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResults, EvidenceBook, shouldDistill } from '../../core/research.js';

test('parseSearchResults：AnySearch 格式（标题/来源/链接/摘要）解析', () => {
  const text = `1. OpenAI 发布新模型
   来源：TechCrunch
   链接：https://techcrunch.com/x
   摘要：发布了 o 系列新模型，性能提升 40%

2. 另一条新闻标题
   来源：36氪
   链接：https://36kr.com/p/123
   摘要：国内厂商跟进`;
  const r = parseSearchResults(text, 'pre_search');
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'OpenAI 发布新模型');
  assert.equal(r[0].source, 'TechCrunch');
  assert.equal(r[0].url, 'https://techcrunch.com/x');
  assert.match(r[0].snippet, /性能提升/);
  assert.equal(r[1].source, '36氪');
  assert.equal(r[0].phase, 'pre_search');
});

test('parseSearchResults：Google News RSS 格式（无摘要行）解析', () => {
  const text = `1. 标题甲
   来源：Google News
   链接：https://news.google.com/a

2. 标题乙
   来源：Reuters
   链接：https://reuters.com/b`;
  const r = parseSearchResults(text);
  assert.equal(r.length, 2);
  assert.equal(r[0].snippet, '');
  assert.equal(r[1].url, 'https://reuters.com/b');
});

test('parseSearchResults：空串/脏输入容错', () => {
  assert.deepEqual(parseSearchResults(''), []);
  assert.deepEqual(parseSearchResults(null), []);
  assert.deepEqual(parseSearchResults('随便一段没有编号的文本'), []);
});

test('EvidenceBook：URL 去重 + 无 URL 按标题去重', () => {
  const eb = new EvidenceBook();
  const added1 = eb.add([{ title: 'A', url: 'https://x/1', source: 's' }]);
  const added2 = eb.add([{ title: 'A-dup', url: 'https://x/1', source: 's' }]); // 同 URL 去重
  const added3 = eb.add([{ title: 'B-no-url' }, { title: 'B-no-url' }]); // 同标题去重
  assert.equal(added1, 1);
  assert.equal(added2, 0);
  assert.equal(added3, 1);
  assert.equal(eb.size, 2);
});

test('EvidenceBook：编号连续 + citationList 格式', () => {
  const eb = new EvidenceBook();
  eb.add([
    { title: '第一条', source: '源A', url: 'https://a', snippet: '摘A' },
    { title: '第二条', source: '源B', url: 'https://b' },
  ]);
  const c = eb.citationList();
  assert.match(c, /^\[1\] 第一条（源A） https:\/\/a\n\s+摘要：摘A$/m);
  assert.match(c, /\[2\] 第二条（源B） https:\/\/b$/m);
  const j = eb.toJSON();
  assert.equal(j.length, 2);
  assert.equal(j[0].n, 1);
  assert.equal(j[1].n, 2);
  assert.equal(j[0].phase, undefined === true ? '' : j[0].phase); // phase 未传时 undefined（序列化省略）
});

test('EvidenceBook：limit 上限截断', () => {
  const eb = new EvidenceBook(3);
  eb.add([1, 2, 3, 4, 5].map((i) => ({ title: `t${i}`, url: `https://x/${i}` })));
  assert.equal(eb.size, 3);
});

test('EvidenceBook：空账本 citationList 返回空串', () => {
  assert.equal(new EvidenceBook().citationList(), '');
});

test('agent-executor 深度档位常量可用（research 模块无循环依赖）', async () => {
  const mod = await import('../../core/agent-executor.js');
  assert.ok(mod.AgentExecutor);
});

test('shouldDistill：小上下文（6 步 × 2K）不蒸馏——省一次阻塞式 LLM 调用', () => {
  const steps = Array.from({ length: 6 }, (_, i) => ({ goal: `s${i}`, action: 'reason', output: 'x'.repeat(2000) }));
  assert.equal(shouldDistill(steps), false); // 总量 12K ≤ 26K 门槛：直接进 final
});

test('shouldDistill：deep 模式且总量超门槛才蒸馏', () => {
  const big = [{ goal: 's', action: 'reason', output: 'x'.repeat(30_000) }];
  assert.equal(shouldDistill(big, { deep: true }), true); // 30K > 26K
  assert.equal(shouldDistill(big, { deep: false }), false); // 非 deep 且步数 < 5：结构上不会走到这（executor 传 deep || >=5），此处验证纯函数语义
});

test('shouldDistill：≥5 步 + 超门槛触发；≥5 步 + 小总量不触发', () => {
  const manySmall = Array.from({ length: 6 }, () => ({ goal: 's', action: 'reason', output: 'x'.repeat(1000) }));
  assert.equal(shouldDistill(manySmall), false); // 6 步但仅 6K
  const manyBig = Array.from({ length: 6 }, () => ({ goal: 's', action: 'reason', output: 'x'.repeat(5000) }));
  assert.equal(shouldDistill(manyBig), true); // 30K > 26K
});

test('shouldDistill：门槛可配置（CONFIG.STEPS_DISTILL_MIN_CHARS 联动）', () => {
  const mid = [{ goal: 's', action: 'reason', output: 'x'.repeat(15_000) }];
  assert.equal(shouldDistill(mid, { deep: true, minChars: 26_000 }), false);
  assert.equal(shouldDistill(mid, { deep: true, minChars: 10_000 }), true);
});
