// tui.js —— 交互终端（readline，零依赖）
// 改进：实时进度显示、ANSI 颜色、任务执行可视化
import readline from 'node:readline';
import { CONFIG } from './config/index.js';
import { bootstrap } from './app.js';
import { getUsage } from './core/llm-adapter.js';

const { store, executor, purify, loop } = bootstrap();

// ANSI 颜色
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

function color(c, text) {
  return `${C[c] || ''}${text}${C.reset}`;
}

function dim(text) {
  return color('gray', text);
}

function bold(text) {
  return color('bold', text);
}

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

// 实时进度显示
let currentTask = null;
let taskProgress = null;

function showProgress(evt) {
  if (!process.stdout.isTTY) return;
  
  const stage = evt.stage;
  const clearLine = () => {
    process.stdout.write('\r\x1b[K');
  };
  
  switch (stage) {
    case 'start':
      clearLine();
      process.stdout.write(color('cyan', '▶ ') + bold('任务已开始'));
      if (evt.taskId) process.stdout.write(dim(` [${evt.taskId.slice(0, 8)}…]`));
      process.stdout.write('\n');
      break;
      
    case 'pre_search':
      clearLine();
      process.stdout.write(color('yellow', '◉ 预检索') + dim(`: ${String(evt.query || '').slice(0, 40)}...`));
      break;
      
    case 'plan':
      clearLine();
      process.stdout.write(color('blue', '◆ 规划') + dim(`: ${evt.steps.length} 个步骤`));
      if (evt.steps.length <= 5) {
        process.stdout.write('\n' + dim('  ' + evt.steps.map((s, i) => `${i + 1}. ${String(s).slice(0, 30)}`).join('\n  ')));
      }
      break;
      
    case 'replan':
      clearLine();
      process.stdout.write(color('magenta', '⟳ 重新规划') + dim(` (第 ${evt.attempt} 次): ${String(evt.reason || '').slice(0, 40)}`));
      break;
      
    case 'step':
      clearLine();
      process.stdout.write(color('green', '●') + dim(` 步骤 ${evt.idx}/${evt.total || '?'} `) + bold(String(evt.goal || '').slice(0, 50)));
      if (evt.replanned) process.stdout.write(color('yellow', ' [重规划]'));
      break;
      
    case 'step_done':
      // 步骤完成，已在下方输出
      break;
      
    case 'retry':
      clearLine();
      process.stdout.write(color('yellow', '↺ 参数修正重试') + dim(`: ${String(evt.error || '').slice(0, 40)}`));
      break;
      
    case 'degrade':
      clearLine();
      process.stdout.write(color('red', '⚠ 降级') + dim(`: ${String(evt.goal || '').slice(0, 30)} → ${String(evt.to || 'reason').slice(0, 10)} (${String(evt.reason || '').slice(0, 30)})`));
      break;
      
    case 'answer':
      clearLine();
      process.stdout.write(color('cyan', '◆ 综合回答') + dim(`: ${String(evt.label || '').slice(0, 40)}`));
      break;
      
    case 'delta':
      // 打字机效果，不显示（由最终结果展示）
      break;
      
    case 'llm_wait':
      clearLine();
      if (evt.kind === 'rate_limit') {
        process.stdout.write(color('yellow', '⏳ 限流等待') + dim(`: ${evt.waitSec}s 后重试 (${evt.nth}/${evt.max})`));
      } else {
        process.stdout.write(color('dim', '⏳ 排队等待') + dim(`: 前方 ${evt.position || '?'} 个请求，已等 ${evt.waitSec}s`));
      }
      break;
      
    default:
      clearLine();
      process.stdout.write(dim(`[进度] ${stage}`));
  }
}

async function handle(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(' ');
  
  switch (cmd) {
    case '': break;
    case 'help': case '?': 
      console.log(bold('evo-agent TUI'));
      console.log(dim('自进化智能体 · 越用越准'));
      console.log('');
      console.log(HELP); 
      break;
    case 'quit': case 'exit': {
      console.log(dim('收尾中...'));
      // 等待在途进化钩子落库（最多 3s）后再关库退出
      await Promise.race([executor._evolveTail ?? Promise.resolve(), new Promise((r) => setTimeout(r, 3000))]);
      shutdown();
      break;
    }
    case 'status': {
      const s = store.stats();
      const l = loop.status();
      const u = getUsage();
      const tasksDone = (s.tasks?.SUCCESS ?? 0) + (s.tasks?.FAIL ?? 0);
      const rate = tasksDone ? Math.round((s.tasks?.SUCCESS ?? 0) / tasksDone * 100) : 0;
      console.log(bold('系统状态'));
      console.log(`${dim('实体')}: 技能 ${s.skill?.total ?? 0} · 记忆 ${s.memory?.total ?? 0} · 经验 ${s.experience?.total ?? 0}`);
      console.log(`${dim('任务')}: 完成 ${tasksDone} · 成功率 ${rate}% · 黄金集 ${s.golden ?? 0}`);
      console.log(`${dim('净化')}: 留痕 ${s.purge_logs ?? 0} 条`);
      const cov = s.embedding_coverage;
      if (cov?.memory?.total) console.log(`${dim('向量')}: 记忆覆盖 ${Math.round(cov.memory.ratio * 100)}% · 技能覆盖 ${Math.round((cov.skill?.ratio ?? 0) * 100)}% · 经验覆盖 ${Math.round((cov.experience?.ratio ?? 0) * 100)}%`);
      console.log(`${dim('用量')}: 今日 ${u.tokensIn + u.tokensOut} tokens (${u.calls} 次调用)`);
      console.log(`${dim('模式')}: ${CONFIG.MOCK ? dim('MOCK 离线') : bold('真实 API')}`);
      break;
    }
    case 'task': case 'ask': {
      if (!arg) { console.log(dim('用法: task <任务描述>')); break; }
      
      // 设置进度回调
      const oldProgress = loop.onProgress;
      loop.onProgress = showProgress;
      
      console.log(bold('执行任务: ') + arg);
      console.log('');
      
      try {
        await loop.submitTask(arg);
        console.log('');
        console.log(color('green', '✓ 任务完成'));
      } catch (e) {
        console.log('');
        console.log(color('red', '✗ 任务失败: ') + e.message);
      } finally {
        loop.onProgress = oldProgress;
      }
      break;
    }
    case 'skills': {
      if (rest[0] === 'install') {
        // C2：skill install owner/repo[/dir] —— Agent Skills 标准一键安装
        const src = rest.slice(1).join('/');
        if (!src) { console.log(color('yellow', '用法：skills install owner/repo[/子目录]')); break; }
        console.log(bold(`正在从 GitHub 安装技能：${src}`));
        try {
          const { installFromGitHub } = await import('./core/fs-skills.js');
          console.log(color('green', '✓ ' + (await installFromGitHub(src))));
        } catch (e) {
          console.log(color('red', '✗ 安装失败: ') + e.message);
        }
        break;
      }
      console.log(bold('技能列表'));
      store.list('skill').slice(0, 30).forEach((r) => console.log(brief(r, 'skill')));
      try {
        const { listFsSkills } = await import('./core/fs-skills.js');
        const fs = listFsSkills();
        if (fs.length) {
          console.log(bold('文件系统技能（Agent Skills 标准）'));
          fs.forEach((s) => console.log(`  ${s.name}  ${dim(s.desc.slice(0, 60))}`));
        }
      } catch { /* 扫描失败不阻塞列表 */ }
      break;
    }
    case 'memories': 
      console.log(bold('记忆列表'));
      store.list('memory').slice(0, 30).forEach((r) => console.log(brief(r, 'memory'))); 
      break;
    case 'experiences': 
      console.log(bold('经验列表'));
      store.list('experience').slice(0, 30).forEach((r) => console.log(brief(r, 'exp'))); 
      break;
    case 'purify': {
      const deep = rest[0] === 'deep';
      console.log(bold(deep ? '深度净化中...' : '净化中...'));
      const report = deep ? await loop.deepPurifyNow() : await purify.runCycle({ deep: false });
      console.log(color('green', '✓ 净化完成'));
      console.log(JSON.stringify({ 
        epoch: report.epoch, 
        detected: report.detected, 
        quarantined: report.quarantined, 
        merged: report.merged, 
        repaired: report.repaired, 
        skipped: report.skipped, 
        review: report.review, 
        frozen: report.frozen, 
        adversarial: report.adversarial, 
        netRate: report.netRate, 
        snapshot: report.snapshot?.id ?? null 
      }, null, 2));
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
      console.log(color('green', '✓ 调参完成'));
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'prompts': {
      console.log(bold('Prompt 版本'));
      for (const p of store.prompts(rest[0] ?? null)) {
        console.log(`${p.role.padEnd(12)} v${p.version} [${p.status}] ${p.sha256.slice(0, 10)}… ${p.content.slice(0, 50)}`);
      }
      break;
    }
    case 'tools': {
      console.log(bold('工具注册表'));
      for (const t of executor.tools.list()) {
        const riskColor = t.risk === 'critical' ? 'red' : t.risk === 'high' ? 'yellow' : 'green';
        console.log(`${color(riskColor, t.risk.padEnd(9))} ${t.name.padEnd(10)} ${t.desc}`);
      }
      break;
    }
    case 'tune-logs': {
      const n = Number(rest[0]) || 10;
      console.log(bold('调参留痕'));
      for (const t of store.tuneLogs(n)) {
        console.log(`${new Date(t.created_at).toLocaleTimeString()} ${t.key_name}: ${t.old_value} → ${t.new_value}${t.golden_gate ? color('green', '（过门禁）') : ''} — ${t.reason.slice(0, 40)}`);
      }
      break;
    }
    case 'restore': {
      if (!arg) { console.log(dim('用法: restore <实体id>')); break; }
      const r = purify.restore(arg);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'logs': {
      const n = Number(rest[0]) || 10;
      console.log(bold('净化留痕'));
      for (const l of store.purgeLogs(n)) {
        const statusColor = l.status === 'DONE' ? 'green' : l.status === 'QUARANTINED' ? 'red' : 'yellow';
        console.log(`${new Date(l.created_at).toLocaleTimeString()} ${color(statusColor, `[${l.status}]`)} ${l.dimension}/${l.action} ${l.entity_id.slice(0, 13)}… ${l.reason}`);
      }
      break;
    }
    case 'golden': {
      if (rest[0] === 'list') {
        console.log(bold('黄金任务集'));
        for (const g of store.db.prepare('SELECT * FROM golden_tasks LIMIT 20').all()) {
          console.log(`${g.id.slice(0, 13)}… [${g.origin}] ${g.input.slice(0, 50)} ⇒ ${g.assertion}`);
        }
      } else if (rest[0] === 'add') {
        const ci = rest.indexOf('--contains');
        const input = rest.slice(1, ci > 0 ? ci : undefined).join(' ');
        const value = ci > 0 ? rest[ci + 1] : null;
        if (!input) { console.log(dim('用法: golden add <任务> --contains <期望包含的文本>')); break; }
        const { uuid7 } = await import('./core/store-base.js');
        store.db.prepare('INSERT INTO golden_tasks (id, input, assertion, origin, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
          .run(uuid7(), input, JSON.stringify(value ? { type: 'contains', value } : { type: 'judge', value: null }), 'user', Date.now());
        console.log(color('green', '✓ 已加入黄金集'));
      } else console.log(dim('用法: golden list | golden add <任务> --contains <断言>'));
      break;
    }
    case 'snapshot': {
      const s = store.snapshot('manual-tui');
      console.log(color('green', '✓ 快照已生成'));
      console.log(`文件: ${s.file}`);
      console.log(`SHA-256: ${s.sha256.slice(0, 16)}…`);
      break;
    }
    case 'usage': {
      const u = getUsage();
      const cfg = await import('./config/index.js');
      console.log(bold('Token 用量'));
      console.log(`今日 in=${u.tokensIn} out=${u.tokensOut} calls=${u.calls} errors=${u.errors}`);
      console.log(`三层预算：日 ${cfg.CONFIG.DAILY_TOKEN_BUDGET / 1000}k | 任务 ${cfg.CONFIG.TASK_TOKEN_BUDGET / 1000}k | 净化周期 ${cfg.CONFIG.PURIFY_CYCLE_TOKEN_BUDGET / 1000}k`);
      break;
    }
    case 'demo': {
      if (!CONFIG.MOCK) { console.log(dim('demo 需要 MOCK 模式：SPA_MOCK=1 node tui.js')); break; }
      const { runDemo } = await import('./scripts/demo.js');
      await runDemo({ store, executor, purify });
      break;
    }
    default: console.log(color('red', `未知命令: ${cmd}`));
      console.log('');
      console.log(HELP);
  }
}

console.log(bold('╔══════════════════════════════════════════════════════════════╗'));
console.log(bold('║') + color('cyan', ' evo-agent · 自进化智能体 ') + bold('║'));
console.log(bold('║') + dim(' 越用越准 · 自净化 · 自进化 ') + bold('║'));
console.log(bold('╚══════════════════════════════════════════════════════════════╝'));
console.log('');
console.log(`模式: ${CONFIG.MOCK ? color('yellow', 'MOCK 离线') : color('green', `真实 API（${CONFIG.LLM_MODEL} @ ${CONFIG.LLM_BASE_URL}）`)}`);
if (!CONFIG.MOCK && !CONFIG.LLM_API_KEY) console.log(color('red', '⚠ 未配置 API Key') + dim('：请在 config/local.json 填 LLM_API_KEY，或用 SPA_MOCK=1 体验离线模式'));
console.log('');
console.log(HELP);
console.log('');

let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  loop.stop();
  try { store.close(); } catch { /* 已关闭 */ }
  process.exit(0);
}

// 注册全局进度回调
loop.onProgress = showProgress;

loop.start();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: color('cyan', 'spa> ') });
rl.prompt();
// 命令串行化：异步命令（如 task）完成前不处理下一条，避免 quit 关库碰上在途任务
let chain = Promise.resolve();
rl.on('line', (line) => {
  chain = chain
    .then(() => handle(line))
    .catch((e) => console.error(color('red', '错误:'), e.message))
    .then(() => { if (!exiting && !rl.closed) rl.prompt(); });
});
rl.on('close', () => shutdown());
