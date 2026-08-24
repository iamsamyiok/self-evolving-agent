// tests/unit/retrieval-perf.test.js —— 检索性能回归：记忆规模增长不拖慢检索
// 验证四件事：
// 1. BM25 倒排检索结果与全量打分一致（正确性不回退）
// 2. 缓存命中路径免重建（记账旁路不触发失效）
// 3. 增量同步：新增/更新/删除只重分词变更条目
// 4. 大记忆池下检索耗时有上界（性能不随 N 线性劣化）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

let Store, MemorySystem, SkillSystem, BM25Index, tokenize;

before(async () => {
  ({ Store } = await import('../../core/store-base.js'));
  ({ MemorySystem } = await import('../../core/memory-system.js'));
  ({ SkillSystem } = await import('../../core/skill-system.js'));
  ({ BM25Index, tokenize } = await import('../../utils/similarity.js'));
});

let store, mem;

function dbPath() { return `/tmp/evo-perf-${randomUUID()}.db`; }

test('BM25 倒排检索与全量打分一致', () => {
  const docs = Array.from({ length: 300 }, (_, i) => ({
    id: `d${i}`,
    text: `文档${i} 关于量子计算与超导量子比特 route${i % 7} 的讨论${i % 3 === 0 ? ' 离子阱' : ''}`,
  }));
  const idx = new BM25Index(docs);
  for (const q of ['量子比特 超导', '离子阱', 'route3', '完全不存在的词']) {
    const fast = idx.search(q, 10).map((h) => h.id);
    // 暴力全量打分（旧实现语义）
    const qTok = tokenize(q);
    const brute = docs
      .map((d) => ({ id: d.id, s: idx.score(qTok, idx.docTokens.get(d.id)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 10)
      .map((x) => x.id);
    assert.deepEqual(fast, brute, `查询「${q}」结果应一致`);
  }
});

test('BM25 remove/add 增量维护 df 与 postings', () => {
  const idx = new BM25Index([{ id: 'a', text: '量子 计算' }, { id: 'b', text: '量子 纠错' }]);
  idx.remove('a');
  assert.equal(idx.df.get('量子'), 1);
  assert.deepEqual(idx.search('量子', 5).map((h) => h.id), ['b']);
  idx.add('c', '量子 纠错 线路');
  assert.equal(idx.df.get('量子'), 2);
  idx.add('c', '完全不同 内容'); // 同 id 重写
  assert.equal(idx.search('量子', 5).length, 1);
});

test('记忆池 5000 条：缓存命中 + 增量同步 + 耗时上界', async () => {
  store = new Store(dbPath());
  mem = new MemorySystem(store);
  // 直接批量插库（绕过 create 的 LLM 路径）
  const ins = store.db.prepare(`INSERT INTO memories (id, state, version, parent_id, origin, created_at, updated_at, immunity_until, execution_count, quality_score, embedding, quarantined_at, purge_after, last_used_at, tier, kind, content, importance, access_count, expires_at, supersede_of, entities, task_id)
    VALUES (?, 'ACTIVE', 1, NULL, 'evolve', ?, ?, ?, 0, 0.6, NULL, NULL, NULL, ?, 'short', 'semantic', ?, 0.6, 0, NULL, NULL, NULL, NULL)`);
  const topics = ['量子计算', '汇率换算', '天气查询', '代码生成', '新闻检索', '数学证明', '文件解析', '网络请求'];
  const t0 = Date.now();
  for (let i = 0; i < 5000; i++) {
    const topic = topics[i % topics.length];
    ins.run(`m${i}`, Date.now(), Date.now(), Date.now(), Date.now() - (i % 90) * 86_400_000,
      `${topic}的通用方法第${i}条：使用工具组合${i % 13}并遵循步骤${i % 29}`);
  }
  const insertMs = Date.now() - t0;

  // 首次检索：构建缓存
  const t1 = Date.now();
  const r1 = mem.retrieve('量子计算 通用方法', 8);
  const firstMs = Date.now() - t1;
  assert.ok(r1.length >= 1, '应检索到量子计算相关记忆');
  assert.ok(r1.every((r) => r.row.content.includes('量子计算')));
  const stats1 = mem.idx.stats();

  // 热路径：连续 20 次检索全部命中缓存（不重建）
  const t2 = Date.now();
  for (let i = 0; i < 20; i++) mem.retrieve(topics[i % topics.length] + ' 工具组合', 8);
  const warm20Ms = Date.now() - t2;
  const stats2 = mem.idx.stats();
  assert.equal(stats2.rebuilds, stats1.rebuilds, '命中记账（touch 旁路）不应触发重建');

  // 增量同步：新增 1 条 → 只同步增量、新条目可检索
  await mem.create({ content: '独特标记词xyzzy：量子纠错用表面码', tier: 'short', skipLLM: true });
  const t3 = Date.now();
  const r3 = mem.retrieve('独特标记词xyzzy', 3);
  const incMs = Date.now() - t3;
  assert.ok(r3.length >= 1 && r3[0].row.content.includes('xyzzy'), '新增记忆应立即可检索');
  assert.ok(incMs < 200, `增量同步应远快于全量重建（${incMs}ms）`);

  // 真实更新（store.update 递增 version）应触发同步
  const target = store.get('memory', 'm0');
  store.update('memory', 'm0', { content: 'm0已改写为独特词plugh测试' });
  const r4 = mem.retrieve('plugh', 3);
  assert.ok(r4.length >= 1, 'update 后的新内容应可检索');

  console.log(`[perf] insert5000=${insertMs}ms firstSearch=${firstMs}ms warm20=${warm20Ms}ms incremental=${incMs}ms rebuilds=${mem.idx.stats().rebuilds}`);
  // 性能护栏：热检索路径不得退化为每次全量重建（旧实现 20 次 ≈ 20×全量分词 ≈ 3000ms+）。
  // 合成语料主题词Posting高度重叠（单主题625条），打分本身偏重，护栏取 1500ms。
  assert.ok(warm20Ms < 1500, `20 次热检索应在 1500ms 内（实际 ${warm20Ms}ms）`);
});

test('技能检索同样走缓存且记账不重建', () => {
  const skills = new SkillSystem(store);
  store.db.prepare(`INSERT INTO skills (id, name, state, version, parent_id, origin, created_at, updated_at, immunity_until, execution_count, quality_score, embedding, quarantined_at, purge_after, last_used_at, scenario, description, steps, params_schema, success_count, fail_count, verified, heat)
    VALUES (?, 'perf_test_skill', 'ACTIVE', 1, NULL, 'evolve', ?, ?, ?, 0, 0.6, NULL, NULL, NULL, ?, '性能测试场景', '性能测试技能描述量子计算', '[]', NULL, 0, 0, 0, 'warm')`)
    .run('s-perf-1', Date.now(), Date.now(), Date.now(), Date.now());
  const r1 = skills.retrieve('量子计算 技能', 5);
  assert.ok(r1.length >= 1 && r1[0].row.name === 'perf_test_skill');
  const b1 = skills.idx.stats().rebuilds;
  skills.retrieve('量子计算 技能', 5); // 再检索一次
  assert.equal(skills.idx.stats().rebuilds, b1, '检索不应触发重建');
});

after(() => { try { store?.close(); } catch { /* 已关闭 */ } });
