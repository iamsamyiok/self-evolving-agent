// app.js —— 系统入口（库引导 + 无头模式 + 服务模式 + 看门狗 + 集群 + 面板）
// 用法：
//   node app.js --task "任务描述"          执行单任务并打印轨迹
//   node app.js --status                  打印系统状态后退出
//   node app.js --demo                    MOCK 离线演示全链路
//   node app.js --serve                   服务模式：双循环常驻 + HTTP 任务接口 + 面板
//   node app.js --watchdog                看门狗监督进程（spawn --serve，心跳停滞/崩溃自动重启）
//   node app.js --cluster [N]             集群模式（N 个 worker，默认 2）
import { CONFIG } from './config/index.js';
import { Store } from './core/store-base.js';
import { AgentExecutor } from './core/agent-executor.js';
import { PurifyCenter } from './core/purify-center.js';
import { AutoControl } from './core/auto-control.js';
import { EvolvePurifyLoop } from './service/evolve-purify-loop.js';
import { getUsage } from './core/llm-adapter.js';
import { bindStoreClass } from './core/auto-control.js';
import { bindLlm } from './extend/monitor-view.js';

bindStoreClass(Store);
bindLlm(await import('./core/llm-adapter.js'));

export function bootstrap() {
  const store = new Store();
  const executor = new AgentExecutor(store);
  const purify = new PurifyCenter(store, executor);
  const control = new AutoControl(store);
  const loop = new EvolvePurifyLoop(executor, purify, control);

  // 任务完成 → 反指标巡检（轻量、异步）
  executor.onTaskDone = () => { try { control.checkCounterMetrics(); } catch { /* 观测失败不阻断 */ } };
  // 深度净化后 → 自动调参 + 策略净化（§6.2.5）
  loop.onDeepCycle = async () => {
    try {
      await control.tune({ executor });
      await control.strategyPurify({ executor });
    } catch (e) { control.event('post_cycle_error', { error: String(e?.message ?? e) }); }
  };
  // 风险净化回滚执行（净利率破线 → pending_rollback 由 control 执行）
  loop.onRiskRollback = async (risk) => {
    if (risk?.action === 'rollback_proposed' && CONFIG.AUTO_ROLLBACK) {
      const r = control.rollbackSnapshot(risk.snapshot);
      control.event('auto_rollback', r);
    }
  };
  return { store, executor, purify, control, loop };
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const { store, executor, purify, control, loop } = bootstrap();

  // 启动自检（宪法哈希/迁移/快照可写/心跳，§4.1.2）
  const check = control.startupCheck();
  if (!check.ok) {
    console.warn('⚠️ 启动自检发现问题（降级启动：仅观测，不接任务）：');
    check.issues.forEach((i) => console.warn('  -', i));
  }

  if (has('--status')) {
    console.log(JSON.stringify({ stats: store.stats(), usage: getUsage(), loop: loop.status(), check }, null, 2));
    store.close();
    return;
  }

  if (has('--demo')) {
    const { runDemo } = await import('./scripts/demo.js');
    await runDemo({ store, executor, purify, control });
    store.close();
    return;
  }

  const taskIdx = argv.indexOf('--task');
  if (taskIdx >= 0) {
    loop.start();
    const input = argv.slice(taskIdx + 1).join(' ').trim();
    if (!input) { console.error('用法: node app.js --task "任务描述"'); process.exit(1); }
    try { await loop.submitTask(input); } finally { loop.stop(); store.close(); }
    return;
  }

  if (has('--watchdog')) {
    const { Watchdog } = await import('./core/watchdog.js');
    new Watchdog({ dataDir: CONFIG.DATA_DIR, workerArgs: ['app.js', '--serve'] }).start();
    return;
  }

  if (has('--cluster')) {
    const n = Number(argv[argv.indexOf('--cluster') + 1]) || 2;
    const { ClusterCoordinator } = await import('./extend/cluster.js');
    const cluster = new ClusterCoordinator({ workers: n });
    const status = await cluster.start();
    console.log('[cluster] 就绪:', JSON.stringify(status, null, 2));
    // 演示：无外部请求时挂起，SIGINT 退出
    process.on('SIGINT', () => { cluster.stop(); store.close(); process.exit(0); });
    // 导出 submitTask 供测试/集成
    globalThis.__cluster = cluster;
    return;
  }

  if (has('--serve')) {
    const { MonitorView } = await import('./extend/monitor-view.js');
    const { createServer } = await import('node:http');
    loop.start();
    const dash = new MonitorView({ store, loop, purify, control });
    await dash.listen(CONFIG.DASHBOARD_PORT, (input) => loop.submitTask(input));
    // 任务提交 HTTP 接口（服务模式核心）
    const srv = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/task') {
        let body = '';
        for await (const c of req) body += c;
        try {
          const { input } = JSON.parse(body);
          const trace = await loop.submitTask(input);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ outcome: trace.outcome, answer: trace.answer, error: trace.error }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e.message) }));
        }
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(CONFIG.SERVE_PORT, r));
    console.log(`[serve] 任务接口 http://127.0.0.1:${CONFIG.SERVE_PORT}/api/task · 面板 http://127.0.0.1:${CONFIG.DASHBOARD_PORT}`);

    // 优雅停机（§7.3）：SIGTERM → 停止接新任务 → 收尾 → 快照 → 退出
    const shutdown = async (sig) => {
      console.log(`\n[serve] 收到 ${sig}，优雅停机…`);
      loop.stop();
      dash.close();
      srv.close();
      await Promise.race([executor._evolveTail ?? Promise.resolve(), new Promise((r) => setTimeout(r, 3000))]);
      try { store.snapshot('graceful-shutdown'); console.log('[serve] 停机快照完成'); } catch { /* 忽略 */ }
      store.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    return;
  }

  console.log(`self-purify-agent v${(await import('./package.json', { with: { type: 'json' } })).default.version} —— 无头模式
用法:
  node app.js --task "任务描述"     单任务
  node app.js --status              系统状态
  node app.js --demo                MOCK 离线演示
  node app.js --serve               服务模式（双循环 + HTTP + 面板）
  node app.js --watchdog            看门狗监督进程
  node app.js --cluster [N]         集群模式（N worker）
交互模式: node tui.js`);
  store.close();
}

// 作为库被导入时不自动执行
if (process.argv[1] && (process.argv[1].endsWith('app.js') || process.argv[1].endsWith('app.mjs'))) {
  main().catch((e) => { console.error('致命错误:', e); process.exit(1); });
}
