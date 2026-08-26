// core/subagent.js —— 并行子调研代理（D2，吸收 dual-agent plugins/subagent.js）
// 形态：单工具入口 tool:subagent —— 拆多个子课题，各自"搜索→综合"只读流水线并行跑，
// 只回传结论（≤300字+来源），过程不进主上下文（省预算）。
// 纪律：≤3 个子课题；只读（news_search/http_get 白名单）；搜索失败降级知识综合并声明未核实；
//       单子课题单轮搜索（无循环），成本上界 = n×(1 搜索 + 1 LLM)。
import { chat } from './llm-adapter.js';

const MAX_TOPICS = 3;

/** topics 参数归一：数组/逗号/顿号/分号分隔字符串 → [{ topic }] */
export function parseTopics(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string') arr = String(raw).split(/[,，、;；|\n]/);
  else return [];
  return arr
    .map((t) => String(t ?? '').trim().replace(/^[\d.、\s]+/, ''))
    .filter((t) => t && t.length >= 2)
    .slice(0, MAX_TOPICS);
}

/** 单个子代理：搜索一次 → 综合结论（过程丢弃，只留结论与来源） */
async function runOne(executor, topic, label) {
  let evidence = '';
  try {
    const r = await executor.tools.call('news_search', { query: topic.slice(0, 60), maxResults: 6 }, { taskId: label });
    evidence = String(r.output ?? '').slice(0, 4000);
  } catch { /* 搜索失败降级知识综合 */ }
  const sys = '你是调研子代理。基于给定材料输出精炼结论：直接给事实与数字（≤300字），标注来源标题；材料不足处明确说"未找到可靠资料"，禁止编造。';
  const user = evidence
    ? `子课题：${topic}\n\n检索材料：\n${evidence}\n\n请综合出该子课题的结论（≤300字，含关键数字与来源标题）：`
    : `子课题：${topic}\n\n（检索不可用）请基于自身知识回答，开头必须声明"以下内容未经联网核实，基于模型训练数据，可能过时"，禁止编造具体新闻、数字或来源。≤300字。`;
  const r = await chat({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    temperature: 0.2, label,
  }).catch(() => null);
  return { topic, conclusion: r?.text?.trim() || `（子课题「${topic}」调研失败）` };
}

/** 并行子调研入口（executor 注入到 ToolRuntime.subagentRunner） */
export async function runSubagents(executor, params, label = 'subagent') {
  const topics = parseTopics(params?.topics ?? params?.topic);
  if (!topics.length) throw new Error('topics 为空：须提供 1-3 个子课题（数组或顿号/逗号分隔）');
  const results = await Promise.allSettled(topics.map((t) => runOne(executor, t, label)));
  return results
    .map((r, i) => r.status === 'fulfilled'
      ? `【子课题 ${i + 1}】${r.value.topic}\n${r.value.conclusion}`
      : `【子课题 ${i + 1}】${topics[i]}\n（调研失败：${String(r.reason?.message ?? r.reason).slice(0, 100)}）`)
    .join('\n\n');
}
