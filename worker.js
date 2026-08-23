// worker.js —— 集群工作进程（§9.3）：独立数据空间 + stdio JSON 行协议
// 协议：ping→pong(capabilities) / task→result / broadcast(共享技能入池) / tombstone(全局墓碑)
// 纪律：stdout 仅限协议 JSON，所有日志走 stderr（console.log 全局重定向）
console.log = console.error;
import { bootstrap } from './app.js';
import { tokenize } from './utils/similarity.js';

const { store, executor, purify, loop } = bootstrap();
loop.start();
const WORKER_ID = process.env.SPA_WORKER_ID ?? '?';

const capabilities = () => store.list('skill', "WHERE state = 'ACTIVE'").map((s) => s.scenario).slice(0, 20);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// 技能晋升 → 向协调者提案（黄金门禁通过才 verified 广播）
store.setState('cluster_propose_hook', true);
const origVerify = executor.skills.verifyDraft.bind(executor.skills);
executor.skills.verifyDraft = async (id) => {
  const r = await origVerify(id);
  if (r?.status === 'promoted') {
    const s = store.get('skill', id);
    send({ type: 'propose', verified: true, skill: { name: s.name, scenario: s.scenario, description: s.description, steps: s.steps } });
  }
  return r;
};
// 硬清除 → 墓碑上报
const origSweep = purify.sweepExpired.bind(purify);
purify.sweepExpired = async (now) => {
  const swept = await origSweep(now);
  for (const s of swept) send({ type: 'tombstone', digest: s });
  return swept;
};

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(JSON.parse(line));
  }
});

async function handle(msg) {
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', capabilities: capabilities() });
      break;
    case 'task': {
      try {
        const trace = await loop.submitTask(msg.input);
        send({ type: 'result', taskId: msg.taskId, trace: { outcome: trace.outcome, answer: trace.answer?.slice(0, 500), error: trace.error } });
      } catch (e) {
        send({ type: 'result', taskId: msg.taskId, trace: { outcome: 'FAIL', error: String(e.message) } });
      }
      // 任务后能力画像可能变化，刷新
      send({ type: 'pong', capabilities: capabilities() });
      break;
    }
    case 'broadcast': {
      // 共享池技能入池（origin=cluster，免疫期保护）
      const id = crypto_uuid();
      const exists = store.list('skill', "WHERE state = 'ACTIVE'").some((s) => s.name === msg.skill.name);
      if (!exists) {
        const now = Date.now();
        store.insert('skill', {
          id, state: 'ACTIVE', version: 1, parent_id: null, origin: 'cluster',
          created_at: now, updated_at: now, immunity_until: now + 48 * 3600_000,
          execution_count: 0, quality_score: 0.5, embedding: null, quarantined_at: null,
          purge_after: null, last_used_at: null, frozen_at: null,
          name: msg.skill.name, scenario: msg.skill.scenario, description: msg.skill.description,
          steps: msg.skill.steps, params_schema: null, success_count: 0, fail_count: 0, verified: 1, heat: 'warm',
        });
      }
      break;
    }
    case 'tombstone':
      // 全局墓碑登记（阻止劣质内容在本节点再生）
      store.addTombstone('skill', `cluster:${msg.digest.slice(0, 40)}`, tokenize(msg.digest));
      break;
    default: break;
  }
}

function crypto_uuid() {
  const ts = Date.now().toString(16).padStart(12, '0');
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-${Math.random().toString(16).slice(2, 6)}-c${WORKER_ID}-${Math.random().toString(16).slice(2, 14)}`;
}

console.log(`[worker-${WORKER_ID}] 就绪（data=${store.dataDir}）`);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
