// core/tools-diff.js —— 文本/文件差异对比（零 token）
import { readFileSync, existsSync } from 'node:fs';
export function runDiff(args) {
  const { file_a, file_b, input_a, input_b, context = 3 } = args ?? {};
  if (file_a && file_b) {
    if (!existsSync(file_a)) throw new Error(`文件不存在：${file_a}`);
    if (!existsSync(file_b)) throw new Error(`文件不存在：${file_b}`);
    return _compute(readFileSync(file_a, 'utf8'), readFileSync(file_b, 'utf8'), { context, source: `${file_a} ↔ ${file_b}` });
  }
  if (input_a && input_b) {
    return _compute(input_a, input_b, { context, source: '输入对比' });
  }
  throw new Error('须传入 (file_a, file_b) 或 (input_a, input_b)');
}
function _compute(a, b, { context = 3, source }) {
  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const result = [];
  let i = 0, j = 0;
  while (i < linesA.length && j < linesB.length) {
    if (linesA[i] === linesB[j]) {
      if (result.length && result[result.length - 1].type !== 'context') {
        // 补 context 行
        for (let k = 1; k <= context; k++) {
          if (i + k < linesA.length && linesA[i + k] === linesB[j + k]) {
            result.push({ type: 'context', value: linesA[i + k] });
          } else break;
        }
      }
      result.push({ type: 'equal', value: linesA[i] });
      i++; j++;
    } else {
      let ai = i, bj = j;
      const alines = [], blines = [];
      while (ai < linesA.length && bj < linesB.length && linesA[ai] !== linesB[bj]) {
        alines.push(linesA[ai++]);
        blines.push(linesB[bj++]);
        if (alines.length + blines.length > 200) break; // 防爆炸
      }
      if (alines.length || blines.length) {
        if (result.length && result[result.length - 1].type !== 'context') {
          for (let k = 1; k <= context && i - k >= 0 && j - k >= 0 && linesA[i - k] === linesB[j - k]; k++) {
            result.unshift({ type: 'context', value: linesA[i - k] });
          }
        }
        result.push({ type: 'delete', value: alines.join('\n') });
        result.push({ type: 'insert', value: blines.join('\n') });
      } else {
        result.push({ type: 'equal', value: linesA[i] }); i++; j++;
      }
    }
  }
  while (i < linesA.length) { result.push({ type: 'delete', value: linesA[i++] }); }
  while (j < linesB.length) { result.push({ type: 'insert', value: linesB[j++] }); }
  const output = [];
  let added = 0, deleted = 0;
  for (const r of result) {
    if (r.type === 'delete') { deleted += r.value.split('\n').length; output.push(`- ${r.value}`); }
    else if (r.type === 'insert') { added += r.value.split('\n').length; output.push(`+ ${r.value}`); }
    else output.push(`  ${r.value}`);
  }
  const hasDiff = added > 0 || deleted > 0;
  return JSON.stringify({ source, hasDiff, addedLines: added, deletedLines: deleted, unifiedDiff: output.join('\n') }, null, 2).slice(0, 4000);
}
