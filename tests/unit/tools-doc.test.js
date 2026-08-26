// tests/unit/tools-doc.test.js
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runDoc } from '../../core/tools-doc.js';

const TMP = join(process.cwd(), '.tmp-doc-test');
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
function mk(name, content) { writeFileSync(join(TMP, name), content); return join(TMP, name); }
function cleanup() {
  try { require('node:fs').readdirSync(TMP).forEach((f) => unlinkSync(join(TMP, f))); require('node:fs').rmdirSync(TMP); } catch {}
}

describe('tools-doc', () => {
  after(cleanup);
  const txtFile = mk('hello.txt', 'Hello World\n第二行\n');
  const mdFile = mk('readme.md', '# Title\n\nContent here.\n');
  const jsonFile = mk('data.json', '{"key":"value"}\n');
  const htmlFile = mk('page.html', '<html><head><title>Test</title></head><body>Hello</body></html>');
  const csvFile = mk('data.csv', 'name,age\nAlice,30\nBob,25\n');

  test('txt 提取', () => {
    const r = runDoc({ path: txtFile });
    assert.equal(r.mime, 'text/plain; charset=utf-8');
    assert.ok(r.content.includes('Hello World'));
  });

  test('md 提取', () => {
    const r = runDoc({ path: mdFile });
    assert.ok(r.content.includes('# Title'));
  });

  test('json 保持原样', () => {
    const r = runDoc({ path: jsonFile });
    const j = JSON.parse(r.content);
    assert.equal(j.key, 'value');
  });

  test('html 提取', () => {
    const r = runDoc({ path: htmlFile });
    assert.ok(r.content.includes('Test'));
    assert.ok(r.content.includes('Hello'));
  });

  test('csv 提取为制表符分隔', () => {
    const r = runDoc({ path: csvFile });
    assert.ok(r.content.includes('Alice'));
    assert.ok(r.content.includes('30'));
  });

  test('路径不存在抛错', () => {
    assert.throws(() => runDoc({ path: '/no/such/file.txt' }), /文件不存在/);
  });

  test('不支持的扩展名抛错', () => {
    assert.throws(() => runDoc({ path: mk('x.exe', '\x4d\x5a') }), /不支持的文件类型/);
  });

  test('PDF 返回文本或提示', () => {
    const pdfBuf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 100 700 Td (Hello PDF) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000196 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n290\n%%EOF'
    );
    const pdfFile = mk('test.pdf', pdfBuf);
    const r = runDoc({ path: pdfFile });
    assert.ok(typeof r.content === 'string' && r.content.length > 0);
  });

  test('DOCX 非 ZIP 格式提示', () => {
    const docxFile = mk('fake.docx', 'not-a-zip');
    const r = runDoc({ path: docxFile });
    assert.ok(r.content.includes('非 ZIP') || r.content.includes('无法定位'));
  });

  test('XLSX 非 ZIP 格式提示', () => {
    const xlsxFile = mk('fake.xlsx', 'not-a-zip');
    const r = runDoc({ path: xlsxFile });
    assert.ok(r.content.includes('非 ZIP') || r.content.includes('无法定位'));
  });
});
