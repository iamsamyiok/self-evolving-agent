// core/safety-constitution.js —— 安全宪法（§8.1，代码级红线，运行期不可被进化修改）
// 红线清单硬编码于本文件；本文件自身哈希在启动自检时校验（被篡改 → 告警事件）。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const CONSTITUTION_VERSION = 'v1';

export const RED_LINES = [
  { id: 'R1', desc: '禁止任何形式的自我代码修改（进化对象仅为数据层）' },
  { id: 'R2', desc: '禁止删除系统关键路径 / 外发凭据 / 批量网络扫描 / 真实金融交易 / 越权数据获取' },
  { id: 'R3', desc: '禁止关闭或绕过：purge_logs 记录、快照前置、预算熔断、心跳' },
  { id: 'R4', desc: '禁止将 LLM_KEY/内部数据写入日志与快照明文' },
  { id: 'R5', desc: '所有对外网络请求必须经工具沙箱白名单代理' },
];

/** 步骤级红线检查（执行内核每步前置调用，§6.2.6） */
export function checkStep(step, { toolRuntime, config }) {
  if (!step) return { ok: true };
  const action = String(step.action ?? 'reason');
  const params = step.params ?? {};

  // 工具动作 → 交给工具运行时的声明式权限校验
  if (action.startsWith('tool:')) {
    if (!config.TOOLS_ENABLED) return { ok: false, reason: 'R5: 工具体系未启用' };
    const name = action.slice(5);
    const tool = toolRuntime?.get(name);
    if (!tool) return { ok: false, reason: `R5: 未注册工具 ${name}` };
    const perm = tool.checkPermissions?.(params) ?? { ok: true };
    if (!perm.ok) return { ok: false, reason: `R2/R5: 工具 ${name} 越权：${perm.reason}` };
    return { ok: true };
  }

  // 非 LLM 内容携带凭据模式（防经 answer/输出通道外泄，R4）
  const blob = JSON.stringify(step);
  if (/sk-[a-zA-Z0-9]{16,}/.test(blob)) return { ok: false, reason: 'R4: 内容疑似携带 API 凭据' };
  if (/(rm\s+-rf\s+\/|del\s+\/[sq])/i.test(blob)) return { ok: false, reason: 'R2: 疑似删除系统路径命令' };
  return { ok: true };
}

/** 宪法自校验：本文件哈希与上次登记一致（被改 → 返回 mismatch；首次登记返回 registered） */
export function selfCheck(store) {
  let sha;
  try {
    const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    sha = createHash('sha256').update(self).digest('hex');
  } catch {
    return { ok: true, note: 'source_unreadable(bundled)' };
  }
  const key = 'constitution_sha';
  const prev = store.getState(key, null);
  if (prev == null) {
    store.setState(key, { sha, version: CONSTITUTION_VERSION, at: Date.now() });
    return { ok: true, registered: true };
  }
  if (prev.sha !== sha) {
    return { ok: false, mismatch: true, prev: prev.sha.slice(0, 12), now: sha.slice(0, 12) };
  }
  return { ok: true };
}
