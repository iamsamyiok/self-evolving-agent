// tui.js —— 交互终端（readline，零依赖）
import readline from 'node:readline';
import { CONFIG } from './config/index.js';
import { bootstrap } from './app.js';
import { getUsage } from './core/llm-adapter.js';

const { store, executor, purify, loop } = bootstrap();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'spa> ' });

const HELP = `命令：
  task <任务描述>            执行任务（规划→分步→判定→进化沉淀）
  status                     系统状态（实体计数 / 队列 / 心跳 / 用量）
  skills | memories | experiences   列出实体（状态/Q/关键字段）
  purify [light|deep]        立即净化周期（deep 含技能/策略/风险维度+④合并⑥复审）
  review [id]                复审抽样（或不带参数抽 10%）
  tune                       立即自动调参（界内+黄金门禁+留痕）
  prompts [role]             Prompt 版本双轨查看
  tools                      工具注册表（沙箱权限）
  restore <实体id>           从隔离区恢复实体
  logs [n=10]                最近 n 条净化留痕
  tune-logs [n=10]           调参留痕
  golden list|add <任务> --contains <断言>   黄金任务集管理
  snapshot                   手动快照（VACUUM INTO + SHA-256）
  usage                      token 用量与三层预算
  demo                       MOCK 离线演示（需 SPA_MOCK=1）
  help | quit
服务模式：node app.js --serve（HTTP 任务接口 + 面板）· --watchdog（看门狗）· --cluster N（集群）`;

function brief(row, type) {
  if (type === 'skill') return `${row.id.slice(0, 13)}… ${row.state.padEnd(10)} Q=${row.quality_score.toFixed(2)} heat=${row.heat.padEnd(4)} n=${row.execution_count} ${row.name}`;
  if (type === 'memory') return `${row.id.slice(0, 13)}… ${row.state.padEnd(10)} Q=${row.quality_score.toFixed(2)} tier=${row.tier.padEnd(6)} acc=${row.access_count} ${row.content.slice(0, 40)}`;
  return `${row.id.slice(0, 13)}… ${row.state.padEnd(10)} Q=${row.quality_score.toFixed(2)} n=${row.execution_count} ${row.summary.slice(0, 40)}`;
}

async function handle(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '': break;
    case 'help': case '?': console.log(HELP); break;
    case 'quit': case 'exit': {
      console.log('收尾中…');
      // 等待在途进化钩子落库（最多 3s）后再关库退出
      await Promise.race([executor._evolveTail ?? Promise.resolve(), new Promise((r) => setTimeout(r, 3000))]);
      shutdown();
      break;
    }
    case 'status':
      console.log(JSON.stringify({ stats: store.stats(), loop: loop.status(), usage: getUsage(), mock: CONFIG.MOCK }, null, 2));
      break;
    case 'task': case 'ask': {
      if (!arg) { console.log('用法: task <任务描述>'); break; }
      console.log('…执行中');
      try { await loop.submitTask(arg); } catch (e) { console.error('任务失败:', e.message); }
      break;
    }
    case 'skills': store.list('skill').slice(0, 30).forEach((r) => console.log(brief(r, 'skill'))); break;
    case 'memories': store.list('memory').slice(0, 30).forEach((r) => console.log(brief(r, 'memory'))); break;
    case 'experiences': store.list('experience').slice(0, 30).forEach((r) => console.log(brief(r, 'exp'))); break;
    case 'purify': {
      const deep = rest[0] === 'deep';
      console.log('…净化中');
      const report = deep ? await loop.deepPurifyNow() : await purify.runCycle({ deep: false });
      console.log(JSON.stringify({ epoch: report.epoch, detected: report.detected, quarantined: report.quarantined, merged: report.merged, repaired: report.repaired, skipped: report.skipped, review: report.review, frozen: report.frozen, adversarial: report.adversarial, netRate: report.netRate, snapshot: report.snapshot?.id ?? null }, null, 2));
      break;
    }
    case 'review': {
      const r = await purify.reviewSampled({ label: 'tui-review', ids: rest[0] ? [rest[0]] : null });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'tune': {
      const { AutoControl } = await import('./core/auto-control.js');
      const ctl = new AutoControl(store);
      const r = await ctl.tune({ executor });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'prompts': {
      for (const p of store.prompts(rest[0] ?? null)) {
        console.log(`${p.role.padEnd(12)} v${p.version} [${p.status}] ${p.sha256.slice(0, 10)}… ${p.content.slice(0, 50)}`);
      }
      break;
    }
    case 'tools': {
      for (const t of executor.tools.list()) console.log(`${t.risk.padEnd(9)} ${t.name.padEnd(10)} ${t.desc}`);
      break;
    }
    case 'tune-logs': {
      const n = Number(rest[0]) || 10;
      for (const t of store.tuneLogs(n)) {
        console.log(`${new Date(t.created_at).toLocaleTimeString()} ${t.key_name}: ${t.old_value} → ${t.new_value}${t.golden_gate ? '（过门禁）' : ''} — ${t.reason.slice(0, 40)}`);
      }
      break;
    }
    case 'restore': {
      if (!arg) { console.log('用法: restore <实体id>'); break; }
      console.log(JSON.stringify(purify.restore(arg)));
      break;
    }
    case 'logs': {
      const n = Number(rest[0]) || 10;
      for (const l of store.purgeLogs(n)) {
        console.log(`${new Date(l.created_at).toLocaleTimeString()} [${l.status}] ${l.dimension}/${l.action} ${l.entity_id.slice(0, 13)}… ${l.reason}`);
      }
      break;
    }
    case 'golden': {
      if (rest[0] === 'list') {
        for (const g of store.db.prepare('SELECT * FROM golden_tasks LIMIT 20').all()) {
          console.log(`${g.id.slice(0, 13)}… [${g.origin}] ${g.input.slice(0, 50)} ⇒ ${g.assertion}`);
        }
      } else if (rest[0] === 'add') {
        const ci = rest.indexOf('--contains');
        const input = rest.slice(1, ci > 0 ? ci : undefined).join(' ');
        const value = ci > 0 ? rest[ci + 1] : null;
        if (!input) { console.log('用法: golden add <任务> --contains <期望包含的文本>'); break; }
        const { uuid7 } = await import('./core/store-base.js');
        store.db.prepare('INSERT INTO golden_tasks (id, input, assertion, origin, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
          .run(uuid7(), input, JSON.stringify(value ? { type: 'contains', value } : { type: 'judge', value: null }), 'user', Date.now());
        console.log('已加入黄金集');
      } else console.log('用法: golden list | golden add <任务> --contains <断言>');
      break;
    }
    case 'snapshot': {
      const s = store.snapshot('manual-tui');
      console.log(`快照已生成: ${s.file}\nSHA-256: ${s.sha256.slice(0, 16)}…`);
      break;
    }
    case 'usage': {
      const u = getUsage();
      const { CONFIG } = await import('./config/index.js');
      console.log(`今日 in=${u.tokensIn} out=${u.tokensOut} calls=${u.calls} errors=${u.errors}`);
      console.log(`三层预算：日 ${CONFIG.DAILY_TOKEN_BUDGET / 1000}k | 任务 ${CONFIG.TASK_TOKEN_BUDGET / 1000}k | 净化周期 ${CONFIG.PURIFY_CYCLE_TOKEN_BUDGET / 1000}k`);
      break;
    }
    case 'demo': {
      if (!CONFIG.MOCK) { console.log('demo 需要 MOCK 模式：SPA_MOCK=1 node tui.js'); break; }
      const { runDemo } = await import('./scripts/demo.js');
      await runDemo({ store, executor, purify });
      break;
    }
    default: console.log(`未知命令: ${cmd}\n${HELP}`);
  }
}

console.log('self-purify-agent v0.1.0 —— 自净化全自动进化 AI Agent（MVP）');
console.log(`模式: ${CONFIG.MOCK ? 'MOCK 离线' : `真实 API（${CONFIG.LLM_MODEL} @ ${CONFIG.LLM_BASE_URL}）`}`);
if (!CONFIG.MOCK && !CONFIG.LLM_API_KEY) console.log('⚠️ 未配置 API Key：请在 config/local.json 填 LLM_API_KEY，或用 SPA_MOCK=1 体验离线模式');
console.log(HELP);
let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  loop.stop();
  try { store.close(); } catch { /* 已关闭 */ }
  process.exit(0);
}
loop.start();
rl.prompt();
// 命令串行化：异步命令（如 task）完成前不处理下一条，避免 quit 关库碰上在途任务
let chain = Promise.resolve();
rl.on('line', (line) => {
  chain = chain
    .then(() => handle(line))
    .catch((e) => console.error('错误:', e.message))
    .then(() => { if (!exiting && !rl.closed) rl.prompt(); });
});
rl.on('close', () => shutdown());
