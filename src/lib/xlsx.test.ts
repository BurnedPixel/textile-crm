import { describe, expect, it } from 'vitest';
import { buildXlsx, type SheetSpec } from './xlsx';

// Mini STORED-ZIP reader: walks local file headers, extracts name + raw bytes.
// Enough to verify buildXlsx's output without pulling in a zip dependency.
function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, Uint8Array>();
  let off = 0;
  while (off < buf.length && dv.getUint32(off, true) === 0x04034b50) {
    const crc = dv.getUint32(off + 14, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const nameStart = off + 30;
    const name = new TextDecoder().decode(buf.slice(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + size);
    out.set(name, data);
    (out as any).__crc = (out as any).__crc || new Map();
    (out as any).__crc.set(name, crc);
    off = dataStart + size;
  }
  return out;
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function countEocdEntries(buf: Uint8Array): number {
  // EOCD is fixed 22 bytes at the tail (no comment written).
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocdOff = buf.length - 22;
  expect(dv.getUint32(eocdOff, true)).toBe(0x06054b50);
  return dv.getUint16(eocdOff + 10, true);
}

describe('buildXlsx', () => {
  const sheets: SheetSpec[] = [
    {
      name: 'Ventas',
      headers: ['Cliente', 'Total'],
      rows: [
        ['Nación & <Cía> "S.A."', 100.5],
        ['Acentuación: ñoño café', NaN],
        [`Control\x01char`, Infinity],
        ['Nulo', null],
        ['Indefinido', undefined],
      ],
    },
  ];

  it('produces a well-formed ZIP with the expected entries and matching EOCD count', () => {
    const buf = buildXlsx(sheets);
    const entries = readZip(buf);
    const expected = [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ];
    for (const name of expected) expect(entries.has(name)).toBe(true);
    expect(countEocdEntries(buf)).toBe(entries.size);
  });

  it('stores a correct CRC32 per entry', () => {
    const buf = buildXlsx(sheets);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 0;
    while (off < buf.length && dv.getUint32(off, true) === 0x04034b50) {
      const crc = dv.getUint32(off + 14, true);
      const size = dv.getUint32(off + 18, true);
      const nameLen = dv.getUint16(off + 26, true);
      const extraLen = dv.getUint16(off + 28, true);
      const dataStart = off + 30 + nameLen + extraLen;
      const data = buf.slice(dataStart, dataStart + size);
      expect(crc32(data)).toBe(crc);
      off = dataStart + size;
    }
  });

  it('escapes XML special chars, keeps accents, strips control chars, and omits non-finite numbers', () => {
    const buf = buildXlsx(sheets);
    const entries = readZip(buf);
    const xml = new TextDecoder().decode(entries.get('xl/worksheets/sheet1.xml'));

    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('ñoño café');
    expect(xml).not.toContain('\x01');
    expect(xml).toContain('<v>100.5</v>');
    // NaN / Infinity / null / undefined rows must not produce a numeric <v> cell for those columns
    expect(xml).not.toMatch(/<v>NaN<\/v>/);
    expect(xml).not.toMatch(/<v>Infinity<\/v>/);
  });

  it('references column 27 as AA', () => {
    const headers = Array.from({ length: 27 }, (_, i) => `col${i + 1}`);
    const buf = buildXlsx([{ name: 'Wide', headers, rows: [] }]);
    const entries = readZip(buf);
    const xml = new TextDecoder().decode(entries.get('xl/worksheets/sheet1.xml'));
    expect(xml).toContain('r="AA1"');
  });

  it('strips leading/trailing apostrophes from a sheet name (LibreOffice drops the sheet)', () => {
    const buf = buildXlsx([
      { name: "'Lead", headers: ['h'], rows: [] },
      { name: "Trail'", headers: ['h'], rows: [] },
      { name: "'".repeat(2) + 'B'.repeat(30), headers: ['h'], rows: [] }, // trim runs after the 31-slice
    ]);
    const workbook = new TextDecoder().decode(readZip(buf).get('xl/workbook.xml'));
    const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['Lead', 'Trail', 'B'.repeat(29)]);
  });

  it('keeps a carriage return inside a cell (XML would normalize a literal CR to LF)', () => {
    const buf = buildXlsx([{ name: 'CR', headers: ['h'], rows: [['linea1\r\nlinea2']] }]);
    const xml = new TextDecoder().decode(readZip(buf).get('xl/worksheets/sheet1.xml'));
    expect(xml).toContain('linea1&#13;\nlinea2');
    expect(xml).not.toContain('\r');
  });

  it('truncates a 40-char sheet name to 31 and disambiguates duplicates', () => {
    const longName = 'A'.repeat(40);
    const buf = buildXlsx([
      { name: longName, headers: ['h'], rows: [] },
      { name: longName, headers: ['h'], rows: [] },
    ]);
    const entries = readZip(buf);
    const workbook = new TextDecoder().decode(entries.get('xl/workbook.xml'));
    const names = [...workbook.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(31);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe('A'.repeat(31));
  });
});
