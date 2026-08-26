// tests/unit/tools-doc.test.js
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { runDoc } from '../../core/tools-doc.js';

const TMP = join(process.cwd(), '.tmp-doc-test');
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
function mk(name, content) { writeFileSync(join(TMP, name), content); return join(TMP, name); }
function cleanup() {
  try { require('node:fs').readdirSync(TMP).forEach((f) => unlinkSync(join(TMP, f))); require('node:fs').rmdirSync(TMP); } catch {}
}
/** 构造最小 ZIP（deflate 条目），验证解压读取路径 */
function mkzip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameB = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUIntLE(0x04034b50, 0, 4);
    local.writeUInt16LE(20, 4);       // version
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(8, 8);        // method = deflate
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameB.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameB, comp);
    const cen = Buffer.alloc(46);
    cen.writeUIntLE(0x02014b50, 0, 4);
    cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameB.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameB]));
    offset += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUIntLE(0x06054b50, 0, 4);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
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

  test('PDF 提取实际文本（非仅非空）', () => {
    const pdfBuf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 100 700 Td (Hello PDF) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000196 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n290\n%%EOF'
    );
    const pdfFile = mk('test.pdf', pdfBuf);
    const r = runDoc({ path: pdfFile });
    assert.ok(r.content.includes('Hello PDF'), `PDF 应提取出 Hello PDF，实际：${r.content.slice(0, 80)}`);
  });

  test('PDF 多词文本 + 空格不被高位映射破坏', () => {
    const pdfBuf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Length 60 >>\nstream\nBT /F1 12 Tf 72 720 Td (Hello World Foo Bar) Tj ET\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
    );
    const r = runDoc({ path: mk('multi.pdf', pdfBuf) });
    assert.ok(r.content.includes('Hello World Foo Bar'), `空格须保持为空格，实际：${r.content.slice(0, 80)}`);
  });

  test('DOCX 非 ZIP 格式提示', () => {
    const docxFile = mk('fake.docx', 'not-a-zip');
    const r = runDoc({ path: docxFile });
    assert.ok(r.content.includes('非 ZIP'));
  });

  test('XLSX 非 ZIP 格式提示', () => {
    const xlsxFile = mk('fake.xlsx', 'not-a-zip');
    const r = runDoc({ path: xlsxFile });
    assert.ok(r.content.includes('非 ZIP'));
  });

  test('DOCX deflate 压缩条目：解压并提取段落文本', () => {
    const docx = mkzip([['word/document.xml',
      '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>Deflate World</w:t></w:r></w:p></w:body></w:document>']]);
    const r = runDoc({ path: mk('real.docx', docx) });
    assert.ok(r.content.includes('Hello'), `应含 Hello，实际：${r.content.slice(0, 80)}`);
    assert.ok(r.content.includes('Deflate World'));
    assert.ok(r.content.includes('\n'), '段落间应有换行');
  });

  test('XLSX deflate 压缩条目：sharedStrings + 行列解析为 TSV', () => {
    const xlsx = mkzip([
      ['xl/sharedStrings.xml', '<sst><si><t>Alice</t></si><si><t>Bob</t></si></sst>'],
      ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>30</v></c></row><row><c t="s"><v>1</v></c><c><v>25</v></c></row></sheetData></worksheet>'],
    ]);
    const r = runDoc({ path: mk('real.xlsx', xlsx) });
    assert.ok(r.content.includes('Alice\t30'), `应含 Alice<TAB>30，实际：${r.content.slice(0, 80)}`);
    assert.ok(r.content.includes('Bob\t25'));
  });
});
