// core/tools-usage.js —— 用量查询：当前/历史记录/预算状态（零 token，纯 DB 读取）
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
export function runUsage(args) {
  const { action, label, days = 7, limit = 20 } = args ?? {};
  const dbDir = process.env.SPA_DATA_DIR ?? join(process.cwd(), 'data');
  const dbFile = join(dbDir, 'app.db');
  if (!existsSync(dbFile)) throw new Error(`数据库不存在：${dbFile}，请先执行任务`);
  // SQLite 是二进制文件，用 better-sqlite3 不行（需原生模块），改用 inner-usage.json
  const usageFile = join(dbDir, 'inner-usage.json');
  if (action === 'get' || !action) return _current(usageFile);
  if (action === 'history') return _history(usageFile, days, limit, label);
  if (action === 'budget') return _budget(usageFile);
  throw new Error(`未知 action：${action}（支持 get/history/budget）`);
}
function _current(usageFile) {
  try {
    const d = JSON.parse(readFileSync(usageFile, 'utf8'));
    return JSON.stringify({ current: d.current ?? {}, dayStart: d.dayStart ?? null }, null, 2);
  } catch { return JSON.stringify({ current: {}, note: '尚未生成用量记录' }); }
}
function _history(usageFile, days, limit, label) {
  try {
    const d = JSON.parse(readFileSync(usageFile, 'utf8'));
    const history = (d.history ?? []).filter((r) => !label || r.label === label);
    const cutoff = Date.now() - days * 86400000;
    return JSON.stringify({ days, label, cutoff, total: history.length, recent: history.slice(-limit).reverse() }, null, 2);
  } catch { return JSON.stringify({ history: [], note: '暂无历史记录' }); }
}
function _budget(usageFile) {
  try {
    const d = JSON.parse(readFileSync(usageFile, 'utf8'));
    const config = JSON.parse(readFileSync(join(process.cwd(), 'config', 'local.json'), 'utf8') ?? '{}');
    const budget = config.DAILY_TOKEN_BUDGET ?? 200000;
    const used = (d.current ?? {}).tokensIn + (d.current ?? {}).tokensOut;
    const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
    return JSON.stringify({ dailyBudget: budget, used, remaining: Math.max(0, budget - used), pct }, null, 2);
  } catch { return JSON.stringify({ note: '无法读取配置' }); }
}
