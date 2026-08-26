// core/tools-diff.js —— 文本/文件差异对比（零 token）
// 算法：单遍扫描 + 定位重对齐（在对方序列中向前找当前行，窗口 200），
// 产出经典 unified diff 语义的 +/-/空格 三类行。相等行原样保留即天然上下文。
import { readFileSync, existsSync } from 'node:fs';

const WINDOW = 200; // 重对齐查找窗口（防 O(n·m) 退化）

export function runDiff(args) {
  const { file_a, file_b, input_a, input_b } = args ?? {};
  if (file_a && file_b) {
    if (!existsSync(file_a)) throw new Error(`文件不存在：${file_a}`);
    if (!existsSync(file_b)) throw new Error(`文件不存在：${file_b}`);
    return _compute(readFileSync(file_a, 'utf8'), readFileSync(file_b, 'utf8'), `${file_a} ↔ ${file_b}`);
  }
  if (input_a != null && input_b != null) {
    return _compute(String(input_a), String(input_b), '输入对比');
  }
  throw new Error('须传入 (file_a, file_b) 或 (input_a, input_b)');
}

function _compute(a, b, source) {
  const A = a.split('\n'), B = b.split('\n');
  const out = [];
  let added = 0, deleted = 0;
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push(`  ${A[i]}`); i++; j++; continue; }
    // B 中前方找到了 A[i] → 中间这段是纯新增
    const bi = B.indexOf(A[i], j);
    if (bi !== -1 && bi - j <= WINDOW) {
      for (; j < bi; j++) { out.push(`+ ${B[j]}`); added++; }
      continue;
    }
    // A 中前方找到了 B[j] → 中间这段是纯删除
    const ai = A.indexOf(B[j], i);
    if (ai !== -1 && ai - i <= WINDOW) {
      for (; i < ai; i++) { out.push(`- ${A[i]}`); deleted++; }
      continue;
    }
    // 互相都找不到 → 视为同行替换
    out.push(`- ${A[i]}`); deleted++;
    out.push(`+ ${B[j]}`); added++;
    i++; j++;
  }
  for (; i < A.length; i++) { out.push(`- ${A[i]}`); deleted++; }
  for (; j < B.length; j++) { out.push(`+ ${B[j]}`); added++; }
  const hasDiff = added > 0 || deleted > 0;
  const unifiedDiff = out.join('\n').slice(0, 4000);
  return JSON.stringify({
    source, hasDiff, addedLines: added, deletedLines: deleted,
    truncated: out.join('\n').length > 4000,
    unifiedDiff,
  }, null, 2);
}
