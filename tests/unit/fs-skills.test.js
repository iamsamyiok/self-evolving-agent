// tests/unit/fs-skills.test.js —— Agent Skills 标准（C1）：frontmatter/扫描/渐进读取/执行回退
// + GitHub 安装（C2）：源解析/tar 解包（本地构造 tar.gz，零网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

test.before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spa-fsk-'));
  process.env.SPA_DATA_DIR = dir;
  process.env.SPA_SKILLS_SHARED = join(dir, 'shared');
  ({ parseFrontmatter, listFsSkills, readFsSkill, parseGitHubSource, untar } = await import('../../core/fs-skills.js'));
});
let parseFrontmatter, listFsSkills, readFsSkill, parseGitHubSource, untar;

test('C1 frontmatter：简单键值/块标量折叠/字面量/续行全兼容', () => {
  const fm = parseFrontmatter('---\nname: pdf-report\ndescription: >-\n  生成 PDF 报告的技能，\n  支持多章节与目录\nlicense: MIT\n---\n正文');
  assert.equal(fm.name, 'pdf-report');
  assert.equal(fm.description, '生成 PDF 报告的技能，支持多章节与目录');
  assert.equal(fm.license, 'MIT');
  const lit = parseFrontmatter('---\ndescription: |\n  第一行\n  第二行\n---\n');
  assert.equal(lit.description, '第一行\n第二行');
  const cont = parseFrontmatter('---\ndescription: 首行\n  续行内容\n---\n');
  assert.equal(cont.description, '首行 续行内容');
  assert.equal(parseFrontmatter('无 frontmatter'), null);
});

test('C1 双根扫描：目录型 + 单文件型，数据目录优先于共享根', () => {
  const data = process.env.SPA_DATA_DIR;
  mkdirSync(join(data, 'skills', 'pdf-report'), { recursive: true });
  writeFileSync(join(data, 'skills', 'pdf-report', 'SKILL.md'), '---\nname: pdf-report\ndescription: 生成 PDF 报告\n---\n# 步骤\n1. 收集素材\n2. 渲染 PDF');
  writeFileSync(join(data, 'skills', 'quick-note.md'), '---\ndescription: 快速笔记模板\n---\n模板正文');
  mkdirSync(join(data, 'shared', 'pdf-report'), { recursive: true });
  writeFileSync(join(data, 'shared', 'pdf-report', 'SKILL.md'), '---\nname: pdf-report\ndescription: 共享根旧版\n---\n旧内容');
  mkdirSync(join(data, 'shared', 'code-review'), { recursive: true });
  writeFileSync(join(data, 'shared', 'code-review', 'SKILL.md'), '---\nname: code-review\ndescription: 代码审查清单\n---\n审查正文');

  const list = listFsSkills();
  const pdf = list.find((s) => s.name === 'pdf-report');
  assert.equal(pdf.desc, '生成 PDF 报告'); // 数据目录覆盖共享根
  assert.ok(list.some((s) => s.name === 'quick-note'));
  assert.ok(list.some((s) => s.name === 'code-review')); // 共享根独有技能可见
  // 渐进披露：readFsSkill 返回全文正文（剥 frontmatter）
  const full = readFsSkill('pdf-report');
  assert.match(full.body, /收集素材/);
  assert.doesNotMatch(full.body, /name: pdf-report/);
  assert.equal(readFsSkill('不存在'), null);
});

test('C2 parseGitHubSource：三种源格式归一', () => {
  assert.deepEqual(parseGitHubSource('anthropics/skills'), { owner: 'anthropics', repo: 'skills', branch: '', subdir: '' });
  assert.deepEqual(parseGitHubSource('anthropics/skills/document-tools/pdf'), { owner: 'anthropics', repo: 'skills', branch: '', subdir: 'document-tools/pdf' });
  const u = parseGitHubSource('https://github.com/anthropics/skills/tree/main/document-tools');
  assert.equal(u.owner, 'anthropics'); assert.equal(u.repo, 'skills'); assert.equal(u.branch, 'main'); assert.equal(u.subdir, 'document-tools');
  assert.throws(() => parseGitHubSource('不是仓库地址'), /无法解析/);
});

// 本地构造 POSIX ustar tar.gz（零网络测解包）
function makeTar(entries) {
  const blocks = [];
  for (const [name, content, type = '0'] of entries) {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 99), 0, 'utf8');
    h.write(Buffer.byteLength(content, 'utf8').toString(8).padStart(11, '0') + '\0', 124, 'utf8');
    h.write(type, 156, 'utf8');
    h.write('ustar\0', 257, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
    blocks.push(h, Buffer.concat([Buffer.from(content, 'utf8'), Buffer.alloc((512 - (Buffer.byteLength(content, 'utf8') % 512)) % 512)]));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test('C2 untar：ustar 头解析 + 目录条目跳过', () => {
  const gz = makeTar([
    ['repo-main/', '', '5'],
    ['repo-main/skills/demo/SKILL.md', '---\nname: demo\ndescription: 演示\n---\n正文'],
    ['repo-main/skills/demo/helper.txt', '辅助'],
  ]);
  const files = untar(gz);
  assert.equal(files.size, 2); // 目录条目不计
  assert.match(files.get('repo-main/skills/demo/SKILL.md').toString(), /name: demo/);
  assert.equal(files.get('repo-main/skills/demo/helper.txt').toString(), '辅助');
  assert.throws(() => untar(Buffer.from('不是gzip')), null);
});

test('C1 executeSkillStep 回退：DB 无此技能时按 SKILL.md 正文执行（MOCK）', async () => {
  const { CONFIG } = await import('../../config/index.js');
  CONFIG.MOCK = true;
  const data = process.env.SPA_DATA_DIR;
  const { Store } = await import('../../core/store-base.js');
  const { AgentExecutor } = await import('../../core/agent-executor.js');
  const store = new Store(join(data, 'store-fallback'));
  const executor = new AgentExecutor(store);
  const out = await executor.executeSkillStep('pdf-report', { topic: '月度总结' }, 't');
  assert.ok(String(out).length > 0); // MOCK 后端返回确定性文本
  // DB 无 + FS 无 → 明确报错
  await assert.rejects(() => executor.executeSkillStep('nope-skill', {}, 't'), /未找到技能/);
  CONFIG.MOCK = false;
});
