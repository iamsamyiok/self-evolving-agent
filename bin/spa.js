#!/usr/bin/env node
// bin/spa.js —— 统一命令入口：spa [tui|task|status|demo] [args...]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [cmd, ...rest] = process.argv.slice(2);
const spawnNode = (entryFile, args) => {
  const child = spawn(process.execPath, [join(ROOT, entryFile), ...args], { stdio: 'inherit' });
  child.on('exit', (c) => process.exit(c ?? 0));
};

switch (cmd) {
  case undefined:
  case 'tui': spawnNode('tui.js', rest); break;
  case 'task': spawnNode('app.js', ['--task', ...rest]); break;
  case 'status': spawnNode('app.js', ['--status']); break;
  case 'demo': spawnNode('app.js', ['--demo']); break;
  case 'test': console.log('请使用: npm test'); break;
  default: console.log('用法: spa [tui] | spa task "..." | spa status | spa demo'); process.exit(1);
}
