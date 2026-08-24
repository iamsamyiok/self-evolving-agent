// core/dynamic-tool-loader.js —— 热插拔工具系统（§9.2 扩展）
// 纪律：工具文件必须是纯函数导出，不引入外部依赖；沙箱约束仍生效。
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(ROOT, '..', 'tools');

/** 从 tools/ 目录动态加载 .js 工具模块（启动时调用；抛错单个跳过不影响整体） */
export async function loadDynamicTools(baseToolRuntime) {
  if (!existsSync(TOOLS_DIR)) return [];
  const loaded = [];
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.js') || file.startsWith('.')) continue;
    try {
      const mod = await import(`${pathToFileURL(join(TOOLS_DIR, file)).href}?t=${Date.now()}`);
      const tool = mod.default ?? mod;
      if (tool && typeof tool.name === 'string' && typeof tool.run === 'function') {
        baseToolRuntime.register(tool);
        loaded.push(tool.name);
      }
    } catch (e) {
      console.warn(`[dynamic-tool] 加载 ${file} 失败:`, e.message);
    }
  }
  return loaded;
}
