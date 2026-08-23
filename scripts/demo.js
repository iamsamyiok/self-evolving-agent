// scripts/demo.js —— MOCK 离线演示：一次跑通「任务执行 → 进化沉淀 → 脏数据注入 → 净化 → 回滚」全链路
// 运行：SPA_MOCK=1 node app.js --demo
import { CONFIG } from '../config/index.js';
import { uuid7 } from '../core/store-base.js';

export async function runDemo({ store, executor, purify }) {
  const line = (t) => console.log(`\n━━━ ${t} ━━━`);

  line('0. 环境');
  console.log(`MOCK=${CONFIG.MOCK}（离线假后端，零 API 成本）`);

  line('1. 任务执行（规划 → 分步 → 判定）');
  const trace = await executor.runTask('帮我总结 Node.js 内置 SQLite 的用法要点', { silent: true });
  executor.printTrace(trace);
  await new Promise((r) => setTimeout(r, 300)); // 进化钩子异步落库

  line('2. 进化沉淀（记忆 / 经验 / 技能候选）');
  const mems = store.list('memory', "WHERE state = 'ACTIVE'");
  const exps = store.list('experience', "WHERE state = 'ACTIVE'");
  const skills = store.list('skill');
  console.log(`记忆 ${mems.length} 条、经验 ${exps.length} 条、技能 ${skills.length} 个`);
  for (const m of mems) console.log(`  [记忆] ${m.content.slice(0, 50)}（tier=${m.tier}, 免疫至 ${new Date(m.immunity_until).toLocaleTimeString()}）`);
  for (const e of exps) console.log(`  [经验] ${e.summary.slice(0, 50)}（evidence=${JSON.parse(e.evidence).length} 条）`);

  line('3. 注入脏数据（过期记忆 / 冗余对 / 坏行 / 正常实体）');
  const now = Date.now();
  const mk = (extra) => ({ id: uuid7(), state: 'ACTIVE', version: 1, parent_id: null, origin: 'migrate', created_at: now - 40 * 86_400_000, updated_at: now - 40 * 86_400_000, immunity_until: now - 86_400_000, execution_count: 9, quality_score: 0.4, embedding: null, quarantined_at: null, purge_after: null, last_used_at: now - 40 * 86_400_000, ...extra });
  store.insert('memory', mk({ tier: 'short', kind: 'semantic', content: 'DEMO 过期记忆：旧版本接口说明', importance: 0.5, access_count: 1, expires_at: now - 86_400_000, supersede_of: null, entities: null, task_id: null }));
  store.insert('memory', mk({ tier: 'long', kind: 'semantic', content: 'DEMO 冗余记忆甲：项目使用 Node.js 22 与 node:sqlite', importance: 0.9, access_count: 9, expires_at: null, supersede_of: null, entities: null, task_id: null }));
  store.insert('memory', mk({ tier: 'long', kind: 'semantic', content: 'DEMO 冗余记忆甲：项目使用 Node.js 22 与 node:sqlite', importance: 0.5, access_count: 2, expires_at: null, supersede_of: null, entities: null, task_id: null }));
  store.insert('experience', { id: uuid7(), state: 'ACTIVE', version: 1, parent_id: null, origin: 'migrate', created_at: now - 86_400_000, updated_at: now - 86_400_000, immunity_until: now - 86_400_000, execution_count: 0, quality_score: 0.5, embedding: null, quarantined_at: null, purge_after: null, last_used_at: now - 91 * 86_400_000, task_signature: 'DEMO 失效经验：旧部署流程', summary: '旧部署流程', rules: '{bad json', pitfalls: '[]', failure_taxonomy: null, evidence: '[]', sample_count: 1, success_count: 0, fail_count: 0 });
  console.log('已注入：过期 short 记忆 1、冗余 long 对 1 组（2 条）、失效+坏行经验 1（规则字段损坏）');

  line('4. 净化周期（检测→复核→隔离→留痕）');
  const report = await purify.runCycle({ deep: true });
  console.log(JSON.stringify({ epoch: report.epoch, detected: report.detected, quarantined: report.quarantined, skipped: report.skipped, snapshot: report.snapshot?.id, netRate: report.netRate }, null, 2));

  line('5. 回滚演示（隔离区一键恢复）');
  const q = store.list('memory', "WHERE state = 'QUARANTINED'");
  if (q.length) {
    const r = await purify.restore(q[0].id);
    console.log(`恢复 ${q[0].id.slice(0, 18)}… →`, JSON.stringify(r));
  } else console.log('（本轮无隔离实体）');

  line('6. 终态统计');
  console.log(JSON.stringify(store.stats(), null, 2));
  console.log('\n✅ 演示完成。真实模式：配置 API Key 后运行 node tui.js');
}
