// core/fs-skills.js —— Agent Skills 开放标准兼容（C1/C2，吸收 dual-agent plugins/skill.js）
// 双根扫描：数据目录 skills/（用户可写、安装目标）+ SPA_SKILLS_SHARED（共享根，测试隔离用）
// 目录型 <name>/SKILL.md（YAML frontmatter）+ 单文件型 <name>.md，社区技能直接拷入即用
// 渐进披露：检索/规划只见 name+description；调用时才读全文（SKILL.md 正文即执行指引）
// 一键安装：skill install owner/repo[/dir] → codeload tarball 内存解包 → 落盘 + .installed.json
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CONFIG } from '../config/index.js';

const STD_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function skillRoots() {
  const roots = [join(CONFIG.DATA_DIR, 'skills')];
  const shared = process.env.SPA_SKILLS_SHARED;
  if (shared && resolve(shared) !== resolve(roots[0])) roots.push(shared);
  return roots;
}

/** YAML frontmatter 解析（简单键值 + 块标量 >/>-|/|- + 普通标量续行；无需完整 YAML） */
export function parseFrontmatter(text) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const lines = m[1].split('\n');
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val)) {
      const keyIndent = line.length - line.replace(/^\s+/, '').length;
      const block = [];
      let blockIndent = -1;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) { block.push(''); j++; continue; }
        const ind = l.length - l.replace(/^\s+/, '').length;
        if (ind <= keyIndent) break;
        if (blockIndent < 0) blockIndent = ind;
        block.push(l.slice(Math.min(blockIndent, l.length)));
        j++;
      }
      i = j - 1;
      val = val.startsWith('>')
        ? block.join(' ').replace(/\s+/g, ' ').replace(/([\u4e00-\u9fff，。；：、！？])\s+(?=[\u4e00-\u9fff，。；：、！？])/g, '$1') // 折叠标量：CJK 间不留空格
        : block.join('\n').replace(/\n+$/, '');
    } else if (val) {
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l || !/^\s+\S/.test(l)) break;
        val += ' ' + l.trim();
        j++;
      }
      i = j - 1;
    }
    fm[key] = val.replace(/^["']|["']$/g, '').trim();
  }
  return Object.keys(fm).length ? fm : null;
}

/** 描述截断：词/句边界断开，避免截在词中间 */
function clipDesc(s, max = 160) {
  const str = String(s ?? '').trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('、'));
  return (boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd() + '…';
}

function scanRoot(dir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      const entry = join(dir, e.name, 'SKILL.md');
      if (!existsSync(entry)) continue;
      let name = e.name, desc = '';
      try {
        const text = readFileSync(entry, 'utf8');
        const fm = parseFrontmatter(text);
        if (fm?.name && STD_NAME_RE.test(fm.name)) name = fm.name;
        desc = fm?.description ?? text.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---')).slice(0, 120);
      } catch { /* 读失败按目录名列出 */ }
      out.push({ name, desc: clipDesc(desc), entry, source: 'fs' });
    } else if (e.isFile() && e.name.endsWith('.md')) {
      let desc = '';
      try {
        const text = readFileSync(join(dir, e.name), 'utf8');
        const fm = parseFrontmatter(text);
        desc = fm?.description ?? text.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('---')).slice(0, 120);
      } catch { /* ignore */ }
      out.push({ name: e.name.replace(/\.md$/, ''), desc: clipDesc(desc), entry: join(dir, e.name), source: 'fs' });
    }
  }
  return out;
}

/** 全根合并去重：先扫到者赢（数据目录 > 共享根，就近优先） */
export function listFsSkills() {
  const merged = new Map();
  for (const root of skillRoots()) {
    for (const s of scanRoot(root)) {
      if (!merged.has(s.name)) merged.set(s.name, s);
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 读技能全文（剥 frontmatter，正文即执行指引） */
export function readFsSkill(name) {
  const hit = listFsSkills().find((s) => s.name === name);
  if (!hit) return null;
  try {
    const text = readFileSync(hit.entry, 'utf8');
    return { ...hit, body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim() };
  } catch { return null; }
}

// ── GitHub 一键安装（C2）──

/** 源格式解析：owner/repo | owner/repo/sub/dir | github URL（/tree/branch/sub） */
export function parseGitHubSource(src) {
  let m = String(src).trim().replace(/\.git$/, '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(\/.*)?)?\/?$/i);
  let owner, repo, branch = '', subdir;
  if (m) {
    owner = m[1]; repo = m[2]; branch = m[3] || ''; subdir = (m[4] || '').replace(/^\/+/, '');
  } else {
    m = String(src).trim().match(/^([\w.-]+)\/([\w.-]+)(\/.*)?$/);
    if (!m) throw new Error(`无法解析 GitHub 源：${src}（支持 owner/repo、owner/repo/子目录、完整 URL）`);
    owner = m[1]; repo = m[2]; subdir = (m[3] || '').replace(/^\/+|\/+$/g, '');
  }
  return { owner, repo, branch, subdir };
}

/** tar.gz 内存解包（仅依赖 zlib，POSIX ustar 头；GitHub tarball 足够） */
export function untar(gzBuf) {
  const buf = gunzipSync(gzBuf);
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (!header.some((b) => b !== 0)) break;
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim(), 8) || 0;
    const type = header.toString('utf8', 156, 157);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    off += 512;
    if (type === '0' || type === '') files.set(full, buf.subarray(off, off + size));
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

/** 从 GitHub 安装技能到数据目录 skills/（幂等重装 = 更新；记录 .installed.json） */
export async function installFromGitHub(src) {
  const { owner, repo, branch, subdir } = parseGitHubSource(src);
  const root = skillRoots()[0];
  mkdirSync(root, { recursive: true });
  let br = branch;
  if (!br) {
    try {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { 'User-Agent': 'self-evolving-agent' }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 404) throw new Error(`仓库不存在或不可访问：${owner}/${repo}`);
      br = r.ok ? (await r.json()).default_branch || 'main' : 'HEAD';
    } catch (e) {
      if (String(e?.message).includes('仓库不存在')) throw e;
      br = 'HEAD';
    }
  }
  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${br}`;
  const resp = await fetch(tarUrl, { headers: { 'User-Agent': 'self-evolving-agent' }, signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`下载失败（HTTP ${resp.status}）：${tarUrl}`);
  const files = untar(Buffer.from(await resp.arrayBuffer()));
  if (!files.size) throw new Error('tarball 为空');

  const firstKey = files.keys().next().value;
  const prefix = firstKey.slice(0, firstKey.indexOf('/') + 1);
  const strip = (p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const candidates = new Map();
  const sub = subdir ? `${subdir.replace(/\/+$/, '')}/` : '';
  const subLeaf = subdir ? subdir.split('/').filter(Boolean).pop() : '';
  const subdirIsSkill = sub && [...files.keys()].some((k) => strip(k) === `${sub}SKILL.md`);
  for (const [k, v] of files) {
    const rel = strip(k);
    if (sub) {
      if (!rel.startsWith(sub)) continue;
      const rest = rel.slice(sub.length);
      if (!rest) continue;
      const top = subdirIsSkill ? subLeaf : rest.split('/')[0];
      if (!top) continue;
      if (!candidates.has(top)) candidates.set(top, new Map());
      const inner = subdirIsSkill ? rest : rest.slice(top.length + 1);
      if (inner) candidates.get(top).set(inner, v);
    } else {
      const parts = rel.split('/');
      if (parts.length < 2) continue; // 仓库根散文件不算技能
      if (!candidates.has(parts[0])) candidates.set(parts[0], new Map());
      candidates.get(parts[0]).set(parts.slice(1).join('/'), v);
    }
  }
  let toInstall = [...candidates].filter(([, fmap]) => fmap.has('SKILL.md')).map(([name, files2]) => ({ name, files: files2 }));
  if (!toInstall.length) {
    throw new Error(`未在 ${owner}/${repo}${subdir ? `/${subdir}` : ''} 中找到含 SKILL.md 的技能目录（Agent Skills 标准）`);
  }
  toInstall = toInstall.slice(0, 30); // 上限保护

  const metaPath = join(root, '.installed.json');
  let meta = {};
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { /* 无记录 */ }
  const installed = [];
  for (const it of toInstall) {
    const safeName = it.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-');
    const dest = join(root, safeName);
    if (existsSync(dest) && !existsSync(join(dest, 'SKILL.md'))) {
      throw new Error(`目标目录已存在且不是技能目录，拒绝覆盖：${dest}`);
    }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    let n = 0, bytes = 0;
    // 防路径逃逸写入：目标必须落在技能目录内
    for (const [rel, content] of it.files) {
      const target = join(dest, rel);
      if (!resolve(target).startsWith(resolve(dest) + String.fromCharCode(47))) continue;
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, content);
      n++; bytes += content.length;
    }
    let stdName = safeName;
    try {
      const fm = parseFrontmatter(readFileSync(join(dest, 'SKILL.md'), 'utf8'));
      if (fm?.name && STD_NAME_RE.test(fm.name)) stdName = fm.name;
    } catch { /* ignore */ }
    meta[stdName] = { source: `github:${owner}/${repo}`, ref: br, dir: safeName, files: n, bytes, installedAt: new Date().toISOString() };
    installed.push(`${stdName}（${n} 个文件，${(bytes / 1024).toFixed(0)}KB）`);
  }
  try { writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch { /* 记录失败不阻塞 */ }
  return `已从 github.com/${owner}/${repo}（${br}）安装 ${installed.length} 个技能到 ${root}：\n${installed.join('\n')}`;
}
