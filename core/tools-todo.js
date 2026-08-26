// core/tools-todo.js —— 跨轮任务清单（存工作区 .todo.json）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const STORAGE_NAME = '.todo.json';
function load(workspace) {
  const p = join(workspace, STORAGE_NAME);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { items: [], updated_at: null }; }
}
function save(workspace, data) { writeFileSync(join(workspace, STORAGE_NAME), JSON.stringify(data, null, 2), 'utf8'); }
export function runTodo(args, workspace) {
  const { action, id, text, tag } = args ?? {};
  const d = load(workspace);
  d.updated_at = new Date().toISOString();
  switch (action) {
    case 'list': {
      const res = (d.items ?? []).map((it) => ({ id: it.id, text: it.text, done: !!it.done, tag: it.tag || null }));
      return JSON.stringify({ total: res.length, done: res.filter((x) => x.done).length, pending: res.filter((x) => !x.done).length, items: res }, null, 2);
    }
    case 'add': {
      if (!text) throw new Error('text 必填');
      d.items = d.items ?? [];
      d.items.push({ id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, text, done: false, tag: tag || null, created_at: d.updated_at });
      save(workspace, d);
      return `已添加 #${d.items.length}：${text}${tag ? ` [${tag}]` : ''}`;
    }
    case 'toggle': {
      if (!id) throw new Error('id 必填');
      const it = (d.items ?? []).find((x) => x.id === id);
      if (!it) throw new Error(`未找到任务 #${id}`);
      it.done = !it.done;
      save(workspace, d);
      return it.done ? `✓ ${it.text}` : `○ ${it.text}`;
    }
    case 'clear': { d.items = (d.items ?? []).filter((x) => !x.done); save(workspace, d); return `已清理已完成项（剩余 ${d.items.length}）`; }
    case 'delete': {
      if (!id) throw new Error('id 必填');
      d.items = (d.items ?? []).filter((x) => x.id !== id);
      save(workspace, d);
      return '已删除';
    }
    default: throw new Error(`未知 action：${action}（支持 list/add/toggle/clear/delete）`);
  }
}
