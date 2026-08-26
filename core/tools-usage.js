// core/tools-usage.js —— 用量查询：当前/历史/预算（零 token）
// 数据源分层：current/budget 走 llm-adapter 内存计数（权威，同进程实时）；
// history 走 <DATA_DIR>/inner-usage.json（llm-adapter 防抖落盘 + 跨日归档，跨重启可查）。
import { getUsage } from './llm-adapter.js';
import { CONFIG } from '../config/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function runUsage(args) {
  const { action, label, days = 7, limit = 20 } = args ?? {};
  if (action === 'history') return _history(days, limit, label);
  if (action === 'budget') return _budget(label);
  if (action && action !== 'get') throw new Error(`未知 action：${action}（支持 get/history/budget）`);
  return _current(label);
}
function _current(label) {
  const u = getUsage(label ?? null);
  return JSON.stringify({ scope: label ? `label:${label}` : 'day', ...u, dailyBudget: CONFIG.DAILY_TOKEN_BUDGET }, null, 2);
}
function _budget(label) {
  const u = getUsage(label ?? null);
  const budget = label ? 50_000 : CONFIG.DAILY_TOKEN_BUDGET; // 标签默认 L1 任务预算 50k
  const used = u.tokensIn + u.tokensOut;
  const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
  return JSON.stringify({ scope: label ? `label:${label}` : 'day', dailyBudget: budget, used, remaining: Math.max(0, budget - used), pctUsed: pct }, null, 2);
}
function _history(days, limit, label) {
  const file = join(CONFIG.DATA_DIR, 'inner-usage.json');
  let history = [];
  let byLabel = {};
  if (existsSync(file)) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      history = Array.isArray(d.history) ? d.history : [];
      byLabel = d.byLabel ?? {};
    } catch { /* 坏文件按空历史处理 */ }
  }
  const cutoff = dayKeyNago(days);
  // 有 label 时返回该标签当日累计（历史按日聚合，不含标签维度）
  if (label) {
    const l = byLabel[label] ?? { tokensIn: 0, tokensOut: 0, calls: 0 };
    return JSON.stringify({ days, label, scope: 'current-day', ...l }, null, 2);
  }
  const rows = history.filter((r) => r.day >= cutoff).slice(-limit).reverse();
  return JSON.stringify({ days, label: null, total: rows.length, recent: rows }, null, 2);
}
function dayKeyNago(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}
