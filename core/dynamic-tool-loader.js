// core/dynamic-tool-loader.js —— 工具锻造区 overlay（吸收 dual-agent WSL-SelfForge 设计）
// 双目录结构：
//   内置还原点（只读）：仓库 tools/ —— 版本化，永不被写/删
//   锻造区（可写）：    <数据目录>/tools-forged/ —— Agent/用户自造、自改工具落盘处
//   同名工具：锻造区覆盖内置（可随时 restore 回滚到还原点）
// 热重载：执行前比对 mtime——锻造区文件变更后无需重启即生效
import { readdirSync, existsSync, statSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG } from '../config/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(ROOT, '..', 'tools');
const FORGE_DIR = process.env.SPA_FORGE_DIR ?? join(CONFIG.DATA_DIR, 'tools-forged');

/** 工具文件解析路径：锻造区存在同名文件则锻造区优先（overlay 覆盖语义） */
function resolveToolPath(base) {
  const forged = join(FORGE_DIR, `${base}.js`);
  if (existsSync(forged)) return { file: forged, source: 'forged' };
  return { file: join(TOOLS_DIR, `${base}.js`), source: 'builtin' };
}

const mtimeCache = new Map(); // base → mtimeMs（锻造区文件变更检测）

/** 动态导入工具模块（缓存穿透：URL 加时间戳强制重载） */
async function importTool(file) {
  const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
  return mod.default ?? mod;
}

/** 锻造区/内置目录扫描：返回 [{ base, source, file }]（锻造区同名覆盖内置） */
function scanOverlay() {
  const merged = new Map();
  for (const [dir, source] of [[TOOLS_DIR, 'builtin'], [FORGE_DIR, 'forged']]) {
    let files = [];
    try { files = readdirSync(dir); } catch { /* 目录不存在 */ }
    for (const f of files) {
      if (!f.endsWith('.js') || f.startsWith('.')) continue;
      merged.set(f.slice(0, -3), { base: f.slice(0, -3), source, file: join(dir, f) });
    }
  }
  return [...merged.values()];
}

/** 注册单个工具到 ToolRuntime（加载失败返回错误信息，不抛出） */
async function registerOne(baseToolRuntime, base, { mtimeCheck = true } = {}) {
  const { file, source } = resolveToolPath(base);
  if (!existsSync(file)) return `文件不存在：${base}.js`;
  // mtime 热重载：仅锻造区文件变更时重新加载（内置目录随代码库版本走）
  if (mtimeCheck && source === 'forged') {
    try {
      const mt = statSync(file).mtimeMs;
      if (mtimeCache.has(base) && mtimeCache.get(base) === mt) return ''; // 未变更
      mtimeCache.set(base, mt);
    } catch { /* stat 失败走正常加载 */ }
  }
  try {
    const tool = await importTool(file);
    if (!tool || typeof tool.name !== 'string' || typeof tool.run !== 'function') {
      return `工具模块须导出 { name: string, run: async (params) => string }`;
    }
    baseToolRuntime.register({ ...tool, forged: source === 'forged' });
    return '';
  } catch (e) {
    return `加载失败：${String(e?.message ?? e).slice(0, 200)}`;
  }
}

/** 启动全量加载（锻造区覆盖内置；失败单个跳过） */
export async function loadDynamicTools(baseToolRuntime) {
  const loaded = [];
  for (const { base } of scanOverlay()) {
    const err = await registerOne(baseToolRuntime, base);
    if (!err) loaded.push(base);
    else console.warn(`[dynamic-tool] ${base}: ${err}`);
  }
  return loaded;
}

/** 执行前热重载检查：锻造区文件变更则重新注册（对 dual-agent mtime 机制）
 *  返回 '' 或错误信息（错误时保留旧版本） */
export async function autoReloadForged(baseToolRuntime, name) {
  const { file, source } = resolveToolPath(name);
  if (source !== 'forged' || !existsSync(file)) return '';
  const mt = statSync(file).mtimeMs;
  if (mtimeCache.has(name) && mtimeCache.get(name) === mt) return '';
  const err = await registerOne(baseToolRuntime, name);
  return err || '';
}

/** 锻造区写工具（内置还原点只读，保障随时回滚） */
export function writeForgedTool(name, code) {
  mkdirSync(FORGE_DIR, { recursive: true });
  writeFileSync(join(FORGE_DIR, `${name}.js`), String(code ?? ''), 'utf8');
  mtimeCache.delete(name);
}

/** 读工具源码（前端查看/编辑用） */
export function readToolCode(name) {
  try { return readFileSync(resolveToolPath(name).file, 'utf8'); } catch { return ''; }
}

/** 删锻造区工具（仅锻造区可删；内置还原点不可删）。返回是否删除了文件 */
export function deleteForgedTool(name) {
  try { unlinkSync(join(FORGE_DIR, `${name}.js`)); mtimeCache.delete(name); return true; } catch { return false; }
}

/** 还原点回滚：删锻造区同名文件 → 重载内置版本（无内置版本等于卸载锻造版） */
export async function restoreTool(baseToolRuntime, name) {
  deleteForgedTool(name);
  const builtinExists = existsSync(join(TOOLS_DIR, `${name}.js`));
  if (builtinExists) {
    const err = await registerOne(baseToolRuntime, name);
    return { ok: !err, err: err || '', restored: true };
  }
  baseToolRuntime.tools.delete(name);
  return { ok: true, err: '', restored: false };
}

/** overlay 清单（含锻造标记与加载状态；前端管理面板用） */
export function listOverlayTools(baseToolRuntime) {
  return scanOverlay().map(({ base, source }) => ({
    name: base,
    source,
    registered: baseToolRuntime.tools.has(baseToolRuntime.resolve(base) ?? base),
    desc: baseToolRuntime.tools.get(base)?.desc ?? '',
  }));
}

export { TOOLS_DIR, FORGE_DIR };
