#!/usr/bin/env node
// bin/spa.js —— 统一命令入口：spa [tui|task|web|status|demo|version|update] [args...]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [cmd, ...rest] = process.argv.slice(2);
const spawnNode = (entryFile, args) => {
  const child = spawn(process.execPath, [join(ROOT, entryFile), ...args], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
};

// registry 可覆盖（国内镜像：SPA_NPM_REGISTRY=https://registry.npmmirror.com）
const REGISTRY = `${process.env.SPA_NPM_REGISTRY ?? 'https://registry.npmjs.org'}/self-evolve/latest`;

async function pkgInfo() {
  return (await import('../package.json', { with: { type: 'json' } })).default;
}

async function latestFromRegistry() {
  try {
    const r = await fetch(REGISTRY, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return (await r.json())?.version ?? null;
  } catch { return null; }
}

async function printVersion() {
  const pkg = await pkgInfo();
  const latest = await latestFromRegistry();
  if (!latest) { console.log(`self-evolve v${pkg.version}（registry 不可达，跳过新版检查）`); return; }
  const cmp = cmpSemver(pkg.version, latest);
  const hint = cmp >= 0 ? '已是最新' : `有新版 v${latest}，运行 spa update 升级`;
  console.log(`self-evolve v${pkg.version}（${hint}）`);
}

/** 语义化版本比较：返回 -1/0/1（镜像同步滞后返回旧版时不算"有新版"） */
function cmpSemver(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function runUpdate() {
  const pkg = await pkgInfo();
  const latest = await latestFromRegistry();
  if (!latest) { console.log('registry 不可达。手动升级：npm i -g self-evolve@latest'); process.exit(1); }
  if (cmpSemver(pkg.version, latest) >= 0) { console.log(`已是最新版本 v${pkg.version}`); return; }
  console.log(`升级 v${pkg.version} → v${latest} ...`);
  // shell:true 兼容 Windows（npm.cmd）；固定参数无注入面
  const child = spawn('npm', ['install', '-g', `self-evolve@${latest}`], { stdio: 'inherit', shell: true });
  child.on('exit', (c) => {
    if (c === 0) {
      console.log(`升级完成：v${latest}。数据目录 ~/.self-evolve/ 与配置跨版本保留，不受影响。`);
    } else {
      console.log(`自动升级失败（exit ${c}）。备选方式：`);
      console.log('  手动在线：  npm i -g self-evolve@latest');
      console.log(`  离线安装：  联网机执行 npm pack self-evolve 取得 tgz，传输后 npm i -g self-evolve-${latest}.tgz`);
      process.exit(c ?? 1);
    }
  });
}

switch (cmd) {
  case undefined:
  case 'tui': spawnNode('tui.js', rest); break;
  case 'task': spawnNode('app.js', ['--task', ...rest]); break;
  case 'web': spawnNode('web.js', rest); break;
  case 'status': spawnNode('app.js', ['--status']); break;
  case 'demo': spawnNode('app.js', ['--demo']); break;
  case 'version':
  case '-v':
  case '--version': printVersion(); break;
  case 'update': runUpdate(); break;
  case 'test': console.log('请使用: npm test'); break;
  default: console.log('用法: spa [tui] | spa task "..." | spa web | spa status | spa demo | spa version | spa update'); process.exit(1);
}
