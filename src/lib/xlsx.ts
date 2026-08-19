// Hand-rolled .xlsx writer — zero dependencies. An .xlsx is just a ZIP of XML
// parts (OOXML SpreadsheetML), so this builds the ZIP container (local file
// headers + central directory + EOCD, STORED entries) and the minimal XML
// parts by hand instead of pulling in a package for it. Pure and synchronous:
// works identically in node (vitest) and the browser.

export type Cell = string | number | null | undefined;
export interface SheetSpec {
  name: string;
  headers: string[];
  rows: Cell[][];
}

const enc = new TextEncoder();

// --- byte helpers --------------------------------------------------------

function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  return b;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// --- CRC32 -----------------------------------------------------------------

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- ZIP (STORED entries only) ---------------------------------------------
// ponytail: entradas STORED (sin compresión) — el .xlsx pesa lo que
// pesa el XML; pasar a deflate si algún informe llega a molestar.

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: stored
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra length
    ]);
    localParts.push(localHeader, nameBytes, entry.data);

    const centralHeader = concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0), // extra length
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset), // local header offset
    ]);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + entry.data.length;
  }

  const centralDir = concat(centralParts);
  const localData = concat(localParts);

  const eocd = concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk with central dir
    u16(entries.length), // entries this disk
    u16(entries.length), // total entries
    u32(centralDir.length),
    u32(localData.length), // offset of central dir
    u16(0), // comment length
  ]);

  return concat([localData, centralDir, eocd]);
}

// --- XML helpers -------------------------------------------------------

/** Escapes XML special chars and strips control chars Excel would reject the whole file for. */
function escXml(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // CR must be an entity: every XML parser normalizes a literal \r to \n on
    // read, silently rewriting the cell's text.
    .replace(/\r/g, '&#13;');
}

/** Base-26 spreadsheet column reference: 1 -> A, 26 -> Z, 27 -> AA. */
function colName(n: number): string {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function sanitizeSheetName(raw: string, index: number): string {
  // The apostrophe trim runs AFTER the slice: truncating to 31 can itself leave
  // a trailing quote, and Excel/LibreOffice reject a sheet name that starts or
  // ends with one — LibreOffice by dropping the whole sheet, without a warning.
  const cleaned = raw.replace(/[[\]:*?/\\]/g, '-').slice(0, 31).replace(/^'+|'+$/g, '');
  return cleaned || `Hoja${index + 1}`;
}

/** Dedupes sheet names case-insensitively, keeping the 31-char Excel limit. */
function dedupeNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((base) => {
    let candidate = base;
    let i = 2;
    while (used.has(candidate.toLowerCase())) {
      const suffix = String(i);
      candidate = base.slice(0, 31 - suffix.length) + suffix;
      i++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function cellText(v: Cell): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function columnWidths(headers: string[], rows: Cell[][]): number[] {
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    row.forEach((cell, j) => {
      const text = cellText(cell);
      if (text === null) return;
      widths[j] = Math.max(widths[j] ?? 0, text.length);
    });
  }
  return widths.map((w) => Math.min(60, Math.max(8, (w || 0) + 2)));
}

function buildSheetXml(sheet: SheetSpec): string {
  const widths = columnWidths(sheet.headers, sheet.rows);
  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('');

  const headerCells = sheet.headers
    .map((h, i) => {
      const ref = `${colName(i + 1)}1`;
      return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${escXml(h)}</t></is></c>`;
    })
    .join('');
  const headerRow = `<row r="1">${headerCells}</row>`;

  const dataRows = sheet.rows
    .map((row, rIdx) => {
      const r = rIdx + 2;
      const cells = row
        .map((cell, cIdx) => {
          const ref = `${colName(cIdx + 1)}${r}`;
          if (typeof cell === 'number') {
            if (!Number.isFinite(cell)) return '';
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          if (typeof cell === 'string') {
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(cell)}</t></is></c>`;
          }
          return '';
        })
        .join('');
      return `<row r="${r}">${cells}</row>`;
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${headerRow}${dataRows}</sheetData>` +
    '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><name val="Calibri"/><b/></font></fonts>' +
  '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '</styleSheet>';

const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

function buildContentTypesXml(sheetCount: number): string {
  const overrides = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    overrides +
    '</Types>'
  );
}

function buildWorkbookXml(names: string[]): string {
  const sheets = names
    .map((name, i) => `<sheet name="${escXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets>` +
    '</workbook>'
  );
}

function buildWorkbookRelsXml(sheetCount: number): string {
  const sheetRels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('');
  const stylesRel = `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetRels +
    stylesRel +
    '</Relationships>'
  );
}

export function buildXlsx(sheets: SheetSpec[]): Uint8Array {
  const names = dedupeNames(sheets.map((s, i) => sanitizeSheetName(s.name, i)));

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: enc.encode(buildContentTypesXml(sheets.length)) },
    { name: '_rels/.rels', data: enc.encode(RELS_XML) },
    { name: 'xl/workbook.xml', data: enc.encode(buildWorkbookXml(names)) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(buildWorkbookRelsXml(sheets.length)) },
    { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) },
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(buildSheetXml(sheet)),
    })),
  ];

  return buildZip(entries);
}
