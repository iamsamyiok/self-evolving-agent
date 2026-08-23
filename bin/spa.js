#!/usr/bin/env node
// bin/spa.js —— 统一命令入口
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [cmd, ...rest] = process.argv.slice(2);
const map = {
  tui: ['tui.js'],
  task: ['app.js', '--task', ...rest],
  status: ['app.js', '--status'],
  demo: ['app.js', '--demo'],
  test: null, // npm test 处理
};
if (cmd === 'test') { console.log('请使用: npm test'); process.exit(0); }
const entry = map[cmd ?? 'tui'] ?? map.tui;
const child = spawn(process.execPath, [join(ROOT, ...entry), ...(cmd === 'tui' ? rest : [])], { stdio: 'inherit' });
child.on('exit', (c) => process.exit(c ?? 0));
