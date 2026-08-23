// app.js —— 系统入口（无头模式 + 库引导）
// 用法：
//   node app.js --task "任务描述"     执行单任务并打印轨迹
//   node app.js --status              打印系统状态后退出
//   node app.js --demo                MOCK 离线演示：任务 → 进化 → 脏数据注入 → 净化 → 回滚
import { CONFIG } from './config/index.js';
import { Store } from './core/store-base.js';
import { AgentExecutor } from './core/agent-executor.js';
import { PurifyCenter } from './core/purify-center.js';
import { EvolvePurifyLoop } from './service/evolve-purify-loop.js';
import { getUsage } from './core/llm-adapter.js';

export function bootstrap() {
  const store = new Store();
  const executor = new AgentExecutor(store);
  const purify = new PurifyCenter(store);
  const loop = new EvolvePurifyLoop(executor, purify);
  return { store, executor, purify, loop };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const taskIdx = process.argv.indexOf('--task');
  const { store, executor, purify, loop } = bootstrap();

  if (cmd === '--status') {
    console.log(JSON.stringify({ stats: store.stats(), usage: getUsage(), loop: loop.status() }, null, 2));
    store.close();
    return;
  }

  if (cmd === '--demo') {
    const { runDemo } = await import('./scripts/demo.js');
    await runDemo({ store, executor, purify });
    store.close();
    return;
  }

  if (taskIdx > 0) {
    loop.start();
    const input = process.argv.slice(taskIdx + 1).join(' ').trim();
    if (!input) { console.error('用法: node app.js --task "任务描述"'); process.exit(1); }
    try {
      await loop.submitTask(input);
    } finally {
      loop.stop();
      store.close();
    }
    return;
  }

  console.log('self-purify-agent —— 无头模式\n用法:\n  node app.js --task "任务描述"\n  node app.js --status\n  node app.js --demo\n交互模式: node tui.js');
  store.close();
}

// 作为库被导入时不自动执行
if (process.argv[1] && process.argv[1].endsWith('app.js')) {
  main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
}
