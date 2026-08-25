#!/usr/bin/env node
// bin/self-evolve.js —— evo-agent · 自进化智能体 · CLI 入口
// npm i -g self-evolve && self-evolve
// 行为：环境检查 → 首次运行配置向导（写 ~/.self-evolve/local.json）→ 启动对话服务 → 打印可点击链接
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_HOME = process.env.SPA_DATA_HOME ?? join(homedir(), '.self-evolve');
const CFG_PATH = join(DATA_HOME, 'local.json');

const BANNER = String.raw`
  ┌─────────────────────────────────────────────┐
  │   evo-agent · 自进化智能体 (self-evolve)     │
  │   技能 / 记忆 / 经验 · 每次任务自动进化      │
  └─────────────────────────────────────────────┘`;

const HELP = `用法: self-evolve [选项]

选项:
  (无)              启动对话服务（首次运行自动进入配置向导）
  --port <N>        对话服务端口（默认 3789）
  --api-key <K>     非交互配置 LLM API Key（OpenAI 兼容）
  --base-url <U>    LLM Base URL（默认 https://api.deepseek.com/v1）
  --model <M>       模型名（默认 deepseek-chat）
  --no-open         不自动打开浏览器
  --config          重新进入配置向导（覆盖 ~/.self-evolve/local.json）
  --help, -h        显示本帮助

环境变量: SPA_API_KEY / SPA_BASE_URL / SPA_MODEL / SPA_WEB_PORT / SPA_DATA_HOME`;

// ── 1. Node 版本门禁：node:sqlite 需 ≥22.13 ──
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) {
  console.error(`✗ 需要 Node.js ≥ 22.13（当前 ${process.versions.node}，node:sqlite 不可用）`);
  console.error('  升级: https://nodejs.org/ 或 nvm install 22 && nvm use 22');
  process.exit(1);
}

// ── 2. 解析参数 ──
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exit(0); }
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const port = Number(opt('--port', process.env.SPA_WEB_PORT ?? 3789));
const noOpen = argv.includes('--no-open');
const reconfig = argv.includes('--config');
const cliKey = opt('--api-key');
const cliBase = opt('--base-url');
const cliModel = opt('--model');

// ── 3. 首次运行配置向导 ──
const readLocal = () => {
  try { return JSON.parse(readFileSync(CFG_PATH, 'utf8')); } catch { return {}; }
};
const writeLocal = (cfg) => {
  mkdirSync(DATA_HOME, { recursive: true });
  writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`✓ 配置已保存: ${CFG_PATH}`);
};

const isFirstRun = !existsSync(CFG_PATH) && !process.env.SPA_API_KEY;
if ((isFirstRun || reconfig) && process.stdin.isTTY) {
  console.log(BANNER);
  console.log(reconfig ? '\n—— 重新配置 ——' : `\n欢迎使用！首次运行需要配置一个 OpenAI 兼容的 LLM API（推荐 DeepSeek / Agnes 等）。\n配置保存在 ${CFG_PATH}，之后可随时用 self-evolve --config 修改。\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const prev = readLocal();
    const prevHasKey = Boolean(prev.LLM_API_KEY);
    const key = (await rl.question(`API Key${prevHasKey ? '（回车保留现有值）' : ''}: `)).trim() || prev.LLM_API_KEY || '';
    const base = (await rl.question(`Base URL [${prev.LLM_BASE_URL ?? 'https://api.deepseek.com/v1'}]: `)).trim() || prev.LLM_BASE_URL || 'https://api.deepseek.com/v1';
    const model = (await rl.question(`模型名 [${prev.LLM_MODEL ?? 'deepseek-chat'}]: `)).trim() || prev.LLM_MODEL || 'deepseek-chat';
    writeLocal({ LLM_API_KEY: key, LLM_BASE_URL: base, LLM_MODEL: model });
  } finally { rl.close(); }
} else if (cliKey) {
  // 非交互配置（CI / 脚本场景）
  const prev = readLocal();
  writeLocal({ ...prev, LLM_API_KEY: cliKey, LLM_BASE_URL: cliBase ?? prev.LLM_BASE_URL ?? 'https://api.deepseek.com/v1', LLM_MODEL: cliModel ?? prev.LLM_MODEL ?? 'deepseek-chat' });
}

// ── 4. 启动服务 ──
console.log(BANNER);
if (!existsSync(CFG_PATH) && !process.env.SPA_API_KEY) {
  console.log('\n⚠ 未检测到 LLM 配置：对话功能将不可用。');
  console.log('  配置方式: ① 重新运行 self-evolve 进入向导  ② self-evolve --api-key <KEY>  ③ 环境变量 SPA_API_KEY');
}
const url = `http://localhost:${port}`;
try {
  // Windows 上 ESM 动态 import 须用 file:// URL（裸 C:\ 路径会被解析为 'c:' 协议）
  const { startWeb } = await import(pathToFileURL(join(ROOT, 'web.js')).href);
  await startWeb({ port });
  console.log(`\n  ➜ 对话界面: ${url}   （Ctrl+C 退出）`);
  if (!noOpen && process.stdin.isTTY) {
    const opener = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
    try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* 无桌面环境时忽略 */ }
  }
} catch (e) {
  console.error('启动失败:', e.message);
  process.exit(1);
}
