// core/tools-doc.js —— 文档提取（零依赖）：.txt/.md/.json/.html/.csv/.tsv/.log/.pdf/.docx/.xlsx 等
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const TEXT_CAP = 16000;
export function runDoc(args, workspace) {
  const { path: p } = args ?? {};
  if (!p) throw new Error('path 必填（本地绝对路径或相对当前目录的路径）');
  const fp = isAbsolute(p) ? p : join(workspace ?? process.cwd(), p);
  if (!existsSync(fp)) throw new Error(`文件不存在：${fp}`);
  const st = statSync(fp);
  const ext = extname(fp).toLowerCase();
  switch (ext) {
    case '.txt': case '.md': case '.json': case '.html': case '.htm': case '.xml':
    case '.csv': case '.tsv': case '.log': case '.rst': case '.yml': case '.yaml':
    case '.toml': case '.ini': case '.cfg': {
      const content = readFileSync(fp, 'utf8');
      return { content, mime: 'text/plain; charset=utf-8', size: st.size, truncated: content.length > TEXT_CAP };
    }
    case '.pdf': {
      const content = _parsePdf(readFileSync(fp));
      return { content, mime: 'application/pdf', size: st.size, truncated: content.length >= TEXT_CAP };
    }
    case '.docx': {
      const content = _parseDocx(readFileSync(fp));
      return { content, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: st.size, truncated: content.length >= 12000 };
    }
    case '.xlsx': {
      const content = _parseXlsx(readFileSync(fp));
      return { content, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: st.size, truncated: content.length >= 8000 };
    }
    case '.xls':
      throw new Error('.xls 为旧版二进制格式，请先转换为 .xlsx 或 .csv');
    default:
      throw new Error(`不支持的文件类型：${ext}。支持 txt/md/json/html/xml/csv/tsv/log/rst/yml/yaml/toml/ini/cfg/pdf/docx/xlsx`);
  }
}

// ── PDF 文本提取（零依赖最小实现）──
// 扫描 (...) Tj / TJ 文本算子。字符串以 \xFE\xFF 开头 → UTF-16BE；
// 否则按 latin1 读出（<0x80 为 ASCII 原样，≥0x80 按 PDFDocEncoding 常用区映射）。
const PDF_HIGH_MAP = {
  0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
  0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
  0x9E: 0x017E, 0x9F: 0x0178,
};
function decodePdfString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    let out = '';
    for (let k = 2; k + 1 < bytes.length; k += 2) out += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
    return out;
  }
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b < 0x80 ? b : (PDF_HIGH_MAP[b] ?? 0xFFFD));
  return out;
}
/** 从流内容中提取括号字符串（处理 \) \( \\ 转义），仅保留 Tj/TJ 算子参数 */
function extractPdfTextOps(streamBytes) {
  const text = streamBytes.toString('latin1');
  let out = '';
  // 匹配 (…) 后跟 Tj，或 TJ 数组 [(…)(…) …] TJ
  const re = /\(((?:\\.|[^\\()])*)\)\s*Tj|\[((?:[^\][\\]|\\.)*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      out += decodePdfString(unescapePdfLiteral(m[1])) + '\n';
    } else if (m[2] !== undefined) {
      const parts = m[2].match(/\(((?:\\.|[^\\()])*)\)/g) ?? [];
      for (const part of parts) out += decodePdfString(unescapePdfLiteral(part.slice(1, -1)));
      out += '\n';
    }
  }
  return out;
}
function unescapePdfLiteral(s) {
  const bytes = [];
  for (let k = 0; k < s.length; k++) {
    let ch = s[k];
    if (ch === '\\') {
      const nxt = s[++k];
      if (nxt === 'n') bytes.push(0x0A);
      else if (nxt === 'r') bytes.push(0x0D);
      else if (nxt === 't') bytes.push(0x09);
      else if (nxt === 'b') bytes.push(0x08);
      else if (nxt === 'f') bytes.push(0x0C);
      else if (nxt >= '0' && nxt <= '7') {
        // 八进制转义（最多 3 位）
        let oct = nxt;
        while (oct.length < 3 && s[k + 1] >= '0' && s[k + 1] <= '7') oct += s[++k];
        bytes.push(parseInt(oct, 8) & 0xFF);
      } else bytes.push(nxt.charCodeAt(0) & 0xFF);
    } else {
      bytes.push(ch.charCodeAt(0) & 0xFF);
    }
  }
  return Buffer.from(bytes);
}
function _parsePdf(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') return '(无效 PDF：缺少 %PDF 头)';
  let out = '';
  // 找 stream…endstream 块（跳过长度校验，按标记切；Flate 压缩流无法零依赖解压时该块产出为空）
  const latin = buf.toString('latin1');
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    const chunk = buf.subarray(start, end);
    // 二进制压缩流的 latin1 表示通常不含可解析的 Tj 算子，extractPdfTextOps 自然返回空
    out += extractPdfTextOps(chunk);
    re.lastIndex = end;
  }
  out = out.replace(/\n{2,}/g, '\n').trim();
  return out.slice(0, TEXT_CAP) || '(无有效文本，可能是扫描件/图片 PDF 或 Flate 压缩内容)';
}

// ── ZIP 定位（DOCX/XLSX 共用：EOCD → 中央目录 → 局部头）──
// 中央目录头布局：0 sig / 4 verMade / 6 verNeed / 8 flags / 10 method / 12 time / 14 date
//   16 crc / 20 compSize / 24 uncompSize / 28 nameLen / 30 extraLen / 32 commentLen
//   34 diskStart / 36 intAttr / 38 extAttr(4) / 42 localOffset / 46 name+extra+comment
// 局部头布局：0 sig / 4 ver / 6 flags / 8 method / ... / 18 compSize / 22 uncompSize
//   26 nameLen / 28 extraLen / 30 name+extra+data
function zipEntries(buf) {
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) return null;
  let eocd = -1;
  for (let k = buf.length - 22; k >= 0; k--) {
    if (buf[k] === 0x50 && buf[k + 1] === 0x4B && buf[k + 2] === 0x05 && buf[k + 3] === 0x06) { eocd = k; break; }
  }
  if (eocd === -1) return null;
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    if (buf[p] !== 0x50 || buf[p + 1] !== 0x4B || buf[p + 2] !== 0x01 || buf[p + 3] !== 0x02) break;
    const namesz = buf.readUInt16LE(p + 28);
    const extrsz = buf.readUInt16LE(p + 30);
    const cmtsz = buf.readUInt16LE(p + 32);
    const compSize = buf.readUInt32LE(p + 20);
    entries.push({
      name: buf.subarray(p + 46, p + 46 + namesz).toString('utf8'),
      compSize,
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + namesz + extrsz + cmtsz;
  }
  return entries;
}
/** 取条目内容（存储型直读；deflate 型 zlib inflateRaw 解压；局部头 size 为 0 时回退中央目录值） */
function zipRead(buf, entry) {
  const lp = entry.localOffset;
  if (buf[lp] !== 0x50 || buf[lp + 1] !== 0x4B || buf[lp + 2] !== 0x03 || buf[lp + 3] !== 0x04) return null;
  const method = buf.readUInt16LE(lp + 8);
  const nameLen = buf.readUInt16LE(lp + 26);
  const extraLen = buf.readUInt16LE(lp + 28);
  let sz = buf.readUInt32LE(lp + 18);
  if (sz === 0) sz = entry.compSize; // data descriptor 场景：局部头 size 置 0
  const data = buf.subarray(lp + 30 + nameLen + extraLen, lp + 30 + nameLen + extraLen + sz);
  if (method === 0) return data;
  if (method === 8) { try { return inflateRawSync(data); } catch { return null; } }
  return null;
}

// ── DOCX（word/document.xml 的 <w:t> 串联）──
function _parseDocx(buf) {
  const entries = zipEntries(buf);
  if (!entries) return '(不支持：非 ZIP 格式，可能是旧版 .doc)';
  const entry = entries.find((e) => e.name === 'word/document.xml');
  if (!entry) return '(未找到 word/document.xml)';
  const raw = zipRead(buf, entry);
  if (raw == null) return '(DOCX 条目读取失败：ZIP 局部头异常或压缩方法不支持)';
  const xml = raw.toString('utf8');
  const texts = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  // 段落边界补换行
  const withParas = xml.replace(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g, '\u0000').replace(/<\/w:p>/g, '\n');
  let out = '', ti = 0;
  for (const ch of withParas) {
    if (ch === '\u0000') out += texts[ti++] ?? '';
    else if (ch === '\n') out += '\n';
  }
  return out.replace(/\n{2,}/g, '\n').trim().slice(0, 12000) || '(文档无文本内容)';
}

// ── XLSX（sharedStrings + 第一个 worksheet → TSV）──
function _parseXlsx(buf) {
  const entries = zipEntries(buf);
  if (!entries) return '(不支持：非 ZIP 格式，可能是旧版 .xls)';
  const strings = [];
  const ssEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  if (ssEntry) {
    const raw = zipRead(buf, ssEntry);
    if (raw != null) {
      for (const m of raw.toString('utf8').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) strings.push(m[1]);
    }
  }
  const sheetEntry = entries.find((e) => /xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!sheetEntry) return '(未找到 worksheet)';
  const raw = zipRead(buf, sheetEntry);
  if (raw == null) return '(XLSX 条目读取失败：ZIP 局部头异常或压缩方法不支持)';
  const xml = raw.toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const type = cm[1].match(/t="([^"]*)"/)?.[1];
      const v = cm[2].match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
      const inline = cm[2].match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/)?.[1];
      if (type === 's') cells.push(strings[Number(v)] ?? v);
      else if (type === 'inlineStr') cells.push(inline ?? v);
      else cells.push(v);
    }
    if (cells.length) rows.push(cells);
    if (rows.length >= 200) break;
  }
  if (!rows.length) return '(worksheet 无数据行)';
  return rows.map((r) => r.join('\t')).join('\n').slice(0, 8000);
}
