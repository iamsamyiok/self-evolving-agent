// scripts/backup.js —— 全量备份（VACUUM INTO 快照）
import { bootstrap } from '../app.js';
const { store } = bootstrap();
const s = store.snapshot(process.argv[2] ?? 'manual-backup');
console.log(`备份完成: ${s.file}`);
console.log(`SHA-256: ${s.sha256}`);
store.close();
