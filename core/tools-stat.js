// core/tools-stat.js —— 文件客观统计（零 token）：字符/行数/字节/CJK/修改时间
import { statSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function runStat(args) {
  const { path: p } = args ?? {};
  if (!p) throw new Error('须传 path');
  return _statOne(p);
}
function _statOne(p) {
  if (!existsSync(p)) throw new Error(`路径不存在：${p}`);
  const st = statSync(p);
  if (st.isDirectory()) {
    let files = 0, dirs = 0, bytes = 0;
    for (const f of readdirSync(p, { recursive: true })) {
      const fp = join(p, f);
      try {
        const s = statSync(fp);
        if (s.isFile()) { files++; bytes += s.size; } else if (s.isDirectory()) dirs++;
      } catch { /* 权限 */ }
    }
    return JSON.stringify({ path: p, type: 'directory', fileCount: files, dirCount: dirs, totalBytes: bytes, modifiedAt: st.mtime.toISOString() }, null, 2);
  }
  const content = readFileSync(p, 'utf8');
  const lines = content.split('\n').length;
  const cjk = [...content].filter((c) => /[\u3000-\u9fff\uff00-\uffef]/.test(c)).length;
  return JSON.stringify({ path: p, type: 'file', bytes: st.size, chars: content.length, cjkChars: cjk, lines, modifiedAt: st.mtime.toISOString() }, null, 2);
}
