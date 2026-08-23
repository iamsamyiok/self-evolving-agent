// utils/token-utils.js —— Token 估算与上下文预算装配（§5.4：先预算后填充）
// 中文 1 字 ≈ 0.6 token，拉丁 1 词 ≈ 1.3 token（指导书 §4.3 估算口径）
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = (text.match(/[A-Za-z0-9_]+/g) ?? []).length;
  return Math.ceil(cjk * 0.6 + latinWords * 1.3);
}

/**
 * 按预算装配条目：各类目保底 1 条，超出总预算时按各类末位淘汰（§5.4）。
 * sections: [{ name, items: [{ id, text, weight? }] }]（weight 大者优先保留）
 * 返回 [{ name, items: [{...原字段, tokens}] }]
 */
export function assembleWithinBudget(sections, budgetTokens) {
  const out = sections.map((s) => ({
    name: s.name,
    items: s.items.map((it) => ({ ...it, tokens: estimateTokens(it.text) })),
  }));
  const total = () => out.reduce((a, s) => a + s.items.reduce((x, it) => x + it.tokens, 0), 0);

  const candidates = [];
  for (const s of out) for (const it of s.items) candidates.push({ sec: s, it });
  candidates.sort((a, b) => (a.it.weight ?? 0) - (b.it.weight ?? 0) || b.it.tokens - a.it.tokens);

  let i = 0;
  while (total() > budgetTokens && i < candidates.length) {
    const { sec, it } = candidates[i++];
    if (sec.items.length <= 1) continue; // 各类保底 1 条，禁止整体截断
    sec.items.splice(sec.items.indexOf(it), 1);
  }
  return out;
}
