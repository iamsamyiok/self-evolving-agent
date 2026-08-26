// core/tools-doc.js —— 文档提取（零依赖）：.txt/.md/.json/.html/.csv/.tsv/.log/.pdf/.docx/.xlsx/.eml/.rst/.yml/.yaml/.toml
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
export function runDoc(args) {
  const { path: p } = args ?? {};
  if (!p) throw new Error('path 必填（本地绝对路径或 workspace 相对路径）');
  const fp = _resolve(p);
  if (!existsSync(fp)) throw new Error(`文件不存在：${fp}`);
  const ext = extname(fp).toLowerCase();
  switch (ext) {
    case '.txt': case '.md': case '.json': case '.html': case '.htm': case '.xml': case '.csv': case '.tsv':
    case '.log': case '.rst': case '.yml': case '.yaml': case '.toml': case '.ini': case '.cfg':
      return { content: readFileSync(fp, 'utf8'), mime: 'text/plain; charset=utf-8', size: stat(fp).size };
    case '.pdf': {
      const buf = readFileSync(fp);
      return { content: _parsePdf(buf), mime: 'application/pdf', size: buf.byteLength, truncated: _truncated(buf.byteLength, 16000) };
    }
    case '.docx': {
      const buf = readFileSync(fp);
      return { content: _parseDocx(buf), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: buf.byteLength, truncated: _truncated(buf.byteLength, 12000) };
    }
    case '.xlsx': case '.xls': {
      const buf = readFileSync(fp);
      return { content: _parseXlsx(buf, ext === '.xls'), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: buf.byteLength, truncated: _truncated(buf.byteLength, 8000) };
    }
    default: throw new Error(`不支持的文件类型：${ext}。支持 txt/md/json/html/csv/tsv/log/pdf/docx/xlsx/xls`);
  }
}
function _resolve(p) { return p.startsWith('/') ? p : join(process.cwd(), p); }
function _truncated(n, max) { return n > max; }
function stat(p) { return { size: readFileSync(p, { flag: 'r' }).byteLength }; }

// ── PDF 最小解析（线性扫文本流，UTF-16BE BOM + PDF 双字节 Unicode 映射） ────────────────
const PDF_UCS2_RE = /\xfe\xff([\x00-\xff][\x00-\xff]+)/g; // UTF-16BE BOM
const PDF_ISO_RE = /BT\s+(\(([^)]{2,})\))\s*Tj/g; // 常见 (string) Tj
const ISO_MAP = {
  0x1c:0x2018,0x1d:0x2019,0x1e:0x201a,0x1f:0x201c,
  0x20:0x201d,0x21:0x2020,0x22:0x2021,0x23:0x2030,
  0x24:0x2039,0x25:0x203a,0x26:0x2022,0x27:0x2023,
  0x28:0x2014,0x29:0x2015,0x2a:0x2e3,0x2b:0x02b9,
  0x2c:0x02ba,0x2d:0x02c6,0x2e:0x02dc,0x2f:0x2042,
  0x30:0x2026,0x31:0x2016,0x32:0x2017,0x33:0x250c,
  0x34:0x2510,0x35:0x2514,0x36:0x2518,0x37:0x253c,
  0x38:0x2500,0x39:0x2500,0x3a:0x2500,0x3b:0x2500,
  0x3c:0x2500,0x3d:0x2500,0x3e:0x2500,0x3f:0x2500,
  0x40:0x2502,0x41:0x2502,0x42:0x2502,0x43:0x2502,
  0x44:0x2502,0x45:0x2502,0x46:0x2502,0x47:0x2502,
  0x48:0x2502,0x49:0x2502,0x4a:0x2502,0x4b:0x2502,
  0x4c:0x2502,0x4d:0x2502,0x4e:0x2502,0x4f:0x2502,
  0x50:0x251c,0x51:0x2524,0x52:0x2534,0x53:0x252c,
  0x54:0x253c,0x55:0x2500,0x56:0x2500,0x57:0x2500,
  0x58:0x2500,0x59:0x2500,0x5a:0x2500,0x5b:0x2500,
  0x5c:0x2500,0x5d:0x2500,0x5e:0x2500,0x5f:0x2500,
  0x60:0x2500,0x61:0x2500,0x62:0x2500,0x63:0x2500,
  0x64:0x2500,0x65:0x2500,0x66:0x2500,0x67:0x2500,
  0x68:0x2500,0x69:0x2500,0x6a:0x2500,0x6b:0x2500,
  0x6c:0x2500,0x6d:0x2500,0x6e:0x2500,0x6f:0x2500,
  0x70:0x2500,0x71:0x2500,0x72:0x2500,0x73:0x2500,
  0x74:0x2500,0x75:0x2500,0x76:0x2500,0x77:0x2500,
  0x78:0x2500,0x79:0x2500,0x7a:0x2500,0x7b:0x2500,
  0x7c:0x2500,0x7d:0x2500,0x7e:0x2500,0x7f:0x2500,
};
function ucs2Decode(s) {
  const m = s.match(PDF_UCS2_RE);
  if (m) return m[0].slice(2).split('').map((c, i) => i % 2 ? c : '').filter(Boolean).join('');
  return '';
}
function isoDecode(s) {
  let out = '';
  for (const ch of s) {
    const b = ch.charCodeAt(0);
    if (b >= 0x80) out += String.fromCodePoint((ISO_MAP[b] ?? 0x3f));
    else out += ch;
  }
  return out;
}
function _parsePdf(buf) {
  let text = '', pos = 0;
  while (pos < buf.length) {
    const lineEnd = buf.indexOf(0x0a, pos);
    const line = buf.slice(pos, lineEnd === -1 ? buf.length : lineEnd);
    const s = line.toString('latin1');
    const tj = s.match(/BT\s+(.*?)\s*Tj/sg);
    if (tj) {
      for (const t of tj) {
        const inner = t.replace(/^BT\s+|\s+Tj$/g, '');
        const parens = [];
        let depth = 0, start = -1;
        for (let i = 0; i < inner.length; i++) {
          if (inner[i] === '(') { if (!depth) start = i + 1; depth++; }
          else if (inner[i] === ')') depth--;
          if (depth === 0 && start !== -1) {
            const seg = inner.slice(start, i);
            text += isoDecode(seg) + (ucs2Decode(seg) ? '' : '');
            if (ucs2Decode(seg)) text += ucs2Decode(seg);
            start = -1;
          }
        }
      }
    }
    pos = lineEnd === -1 ? buf.length : lineEnd + 1;
  }
  return text.trim().slice(0, 16000) || '(无有效文本，可能是扫描件或图片PDF)';
}

// ── DOCX（ZIP 内 word/document.xml） ─────────────────────────────────────────────────────
function _parseDocx(buf) {
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) return '(不支持：非 ZIP 格式)';
  let offset = 0, eocd = -1;
  // find End of Central Directory
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 0x05 && buf[i+3] === 0x06) { eocd = i; break; }
  }
  if (eocd === -1) return '(无法定位 ZIP 中央目录)';
  const entries = [], localOffset = buf.readUInt32LE(eocd + 16);
  const numEntries = buf.readUInt16LE(eocd + 10);
  let p = localOffset;
  for (let n = 0; n < numEntries && p < eocd; n++, p += 46) {
    if (buf[p] !== 0x50 || buf[p+1] !== 0x4B) break;
    const comp = buf.readUInt16LE(p + 8), uncomp = buf.readUInt32LE(p + 10);
    const namesz = buf.readUInt16LE(p + 26), extrsz = buf.readUInt16LE(p + 28);
    const filesz = buf.readUInt32LE(p + 18);
    const name = buf.slice(p + 30, p + 30 + namesz).toString('utf8');
    const dataStart = p + 30 + namesz + extrsz;
    entries.push({ name, offset: dataStart, comp, uncomp });
    if (name === 'word/document.xml') {
      try {
        const xml = buf.slice(dataStart, dataStart + filesz).toString('utf8');
        const texts = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? [];
        return texts.map((t) => t.replace(/<\/?w:t[^>]*>/g, '')).join('').trim().slice(0, 12000);
      } catch { return '(word/document.xml 解析失败)'; }
    }
  }
  return '(未找到 word/document.xml，可能是旧版 .doc)';
}

// ── XLSX（ZIP 内 xl/sharedStrings.xml + xl/worksheets/sheet1.xml） ───────────────────────
function _parseXlsx(buf, isBiff) {
  if (isBiff) return '(不支持：.xls 为二进制格式，请先用 LibreOffice 导出为 .xlsx 或 .csv)';
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) return '(不支持：非 ZIP 格式)';
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 0x05 && buf[i+3] === 0x06) { eocd = i; break; }
  }
  if (eocd === -1) return '(无法定位 ZIP 中央目录)';
  const localOffset = buf.readUInt32LE(eocd + 16);
  const numEntries = buf.readUInt16LE(eocd + 10);
  const strings = {}, sheetRows = [];
  let p = localOffset;
  for (let n = 0; n < numEntries && p < eocd; n++, p += 46) {
    if (buf[p] !== 0x50 || buf[p+1] !== 0x4B) break;
    const namesz = buf.readUInt16LE(p + 26), extrsz = buf.readUInt16LE(p + 28);
    const filesz = buf.readUInt32LE(p + 18), comp = buf.readUInt16LE(p + 8);
    const name = buf.slice(p + 30, p + 30 + namesz).toString('utf8');
    const dataStart = p + 30 + namesz + extrsz;
    const raw = buf.slice(dataStart, dataStart + filesz);
    if (name === 'xl/sharedStrings.xml') {
      const xml = raw.toString('utf8');
      xml.match(/<t[^>]*>([^<]*)<\/t>/g)?.forEach((t) => {
        const idx = parseInt(t.split('>')[0]?.match(/\d+/g)?.pop() ?? '-1');
      });
      // 简洁版：取所有 <t>
      const ts = xml.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g) ?? [];
      ts.forEach((t, i) => { strings[i] = t.replace(/<\/?t[^>]*>/g, ''); });
    } else if (/xl\/worksheets\/sheet\d+\.xml/.test(name) && sheetRows.length === 0) {
      const xml = raw.toString('utf8');
      const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
      let rm;
      while ((rm = rowRe.exec(xml)) && sheetRows.length < 50) {
        const rowNum = rm[1], cellContent = rm[2];
        const row = [];
        const cellRe = /<c(?:\s[^>]*)?>([\s\S]*?)<\/c>/g;
        let cm;
        while ((cm = cellRe.exec(cellContent))) {
          const rawCell = cm[1];
          const type = rawCell.match(/t="([^"]*)"/)?.[1];
          const v = rawCell.match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
          if (type === 's') row.push(strings[parseInt(v)] ?? v);
          else if (type === 'inlineStr') row.push(rawCell.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? v);
          else row.push(v);
        }
        if (row.length) sheetRows.push(row);
      }
    }
  }
  if (!sheetRows.length) return '(未找到 xl/worksheet 数据)';
  return sheetRows.map((r) => r.join('\t')).join('\n').slice(0, 8000);
}
