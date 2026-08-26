// core/tools-probe.js —— HTTP 探测（冒烟验证）：请求 URL 断言状态码/响应包含/关键元素
import { URL } from 'node:url';
export async function runProbe(args) {
  const { url, expect_status, expect_contains, expect_not_contains, expect_title, expect_h1, timeout_ms = 15_000 } = args ?? {};
  if (!url) throw new Error('url 必填');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`无效 URL：${url}`); }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout_ms);
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': 'self-evolving-agent/1.0' } });
    const text = await resp.text().catch(() => '');
    const html = text.slice(0, 8000);
    const checks = [];
    if (expect_status != null) checks.push({ name: 'status', pass: resp.status === expect_status, actual: resp.status });
    if (expect_contains) checks.push({ name: 'contains', pass: html.includes(expect_contains), actual: '---' });
    if (expect_not_contains) checks.push({ name: 'not_contains', pass: !html.includes(expect_not_contains), actual: '---' });
    const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (expect_title) checks.push({ name: 'title', pass: html.includes(expect_title), actual: titleM?.[1] ?? '(无<title>)' });
    const h1M = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (expect_h1) checks.push({ name: 'h1', pass: !!h1M, actual: h1M?.[1] ?? '(无<h1>)' });
    const allPass = checks.length === 0 || checks.every((c) => c.pass);
    return JSON.stringify({ url: parsed.href, status: resp.status, ok: allPass, checks }, null, 2);
  } finally { clearTimeout(timer); }
}
