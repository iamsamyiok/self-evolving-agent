// scripts/restore.js —— 从快照恢复（先自动再备份当前库，双保险）
// 用法：node scripts/restore.js <快照文件名或绝对路径>
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG } from '../config/index.js';

const arg = process.argv[2];
if (!arg) { console.error('用法: node scripts/restore.js <snap-xxx.db>'); process.exit(1); }
const target = existsSync(arg) ? resolve(arg) : join(CONFIG.DATA_DIR, 'snapshots', arg);
if (!existsSync(target)) { console.error(`快照不存在: ${target}`); process.exit(1); }

const dbPath = join(CONFIG.DATA_DIR, 'agent.db');
mkdirSync(CONFIG.DATA_DIR, { recursive: true });
const bak = join(CONFIG.DATA_DIR, `agent.pre-restore-${Date.now()}.db`);
if (existsSync(dbPath)) copyFileSync(dbPath, bak);
copyFileSync(target, dbPath);
for (const ext of ['-wal', '-shm']) {
  const p = dbPath + ext;
  if (existsSync(p)) { import('node:fs').then((fs) => fs.unlinkSync(p)); }
}
console.log(`✅ 已恢复: ${target} → ${dbPath}`);
console.log(`原库已备份: ${bak}（确认无误后可删除）`);
