/**
 * CSV parsing and serialising for bulk import / export.
 *
 * Written by hand rather than pulled from a dependency because the format is
 * small, the rules are exact, and the naive `split(',')` that a spreadsheet
 * feature usually starts with breaks on the very first product description
 * containing a comma — which is most of them.
 *
 * Implements RFC 4180: fields may be quoted, a quoted field may contain
 * commas, newlines and doubled quotes (""), and rows may end \n or \r\n.
 *
 * XLSX is handled separately and lazily (see readWorkbook) so the optional
 * `xlsx` dependency is not required for the CSV path to work.
 */

/** Parse a CSV document into an array of row arrays. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text || '').replace(/^﻿/, ''); // strip a BOM from Excel

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        // "" inside a quoted field is a literal quote.
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  // A file that does not end in a newline still has a final row.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  // Drop trailing blank lines, which every spreadsheet export leaves behind.
  while (rows.length && rows[rows.length - 1].every((c) => String(c).trim() === '')) rows.pop();
  return rows;
}

/** Rows → objects keyed by the header row, with the original line numbers. */
function parseCsvToObjects(text, expect = []) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  // A CSV saved out of Zenoti carries the same title rows as the XLSX.
  const head = findHeaderRow(rows, expect);
  const headers = (rows[head] || []).map((h) => String(h || '').trim());
  const records = rows.slice(head + 1)
    .filter((cells) => cells.some((c) => String(c ?? '').trim() !== ''))
    .map((cells, index) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] === undefined ? '' : String(cells[i]).trim(); });
      // +2: one for the header row, one because humans count from 1. This is the
      // number the error report has to quote for it to be usable in Excel.
      return { row: head + index + 2, data: obj };
    });
  return { headers, records };
}

/** Escape one value for CSV output. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Objects → a CSV document with the given column order. */
function toCsv(columns, rows) {
  const head = columns.map(csvCell).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\n');
  // The BOM makes Excel open a UTF-8 file without mangling accented names.
  return `﻿${head}\n${body}\n`;
}

/**
 * Read an uploaded CSV or XLSX buffer into { headers, records }.
 *
 * XLSX support is optional: `xlsx` is required lazily, so a deployment without
 * it still imports CSV rather than failing to boot. The caller gets a clear
 * message instead of a stack trace.
 */
/**
 * Find the real header row in a grid.
 *
 * A file exported straight out of Zenoti opens with title rows —
 *   Curispro Health Care Services PVT LTD
 *   Center : Jubilee Hills
 *   Services
 *   ServiceCode | ServiceName | Category | ...
 * — so taking row 0 as the header reads the company name as a column and every
 * real row as data with no headers. The clinic should not have to hand-edit an
 * export before uploading it, so the header is located instead of assumed:
 * the first row (within the first 25) that contains at least two of the
 * columns we expect. Falls back to row 0 when nothing matches, which is the
 * ordinary case for our own template.
 */
function findHeaderRow(grid, expect = []) {
  if (!expect.length) return 0;
  const want = new Set(expect.map((c) => String(c).trim().toLowerCase()));
  const limit = Math.min(grid.length, 25);
  for (let i = 0; i < limit; i += 1) {
    const cells = (grid[i] || []).map((c) => String(c ?? '').trim().toLowerCase());
    if (cells.filter((c) => c && want.has(c)).length >= 2) return i;
  }
  return 0;
}

function readWorkbook(file, expect = []) {
  const name = String(file?.originalname || '').toLowerCase();
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');

  if (!isExcel) return parseCsvToObjects(file.buffer.toString('utf8'), expect);

  let xlsx;
  try {
    // eslint-disable-next-line global-require
    xlsx = require('xlsx');
  } catch (_) {
    const err = new Error('XLSX files are not supported on this server yet — please upload a CSV.');
    err.status = 400;
    throw err;
  }
  const wb = xlsx.read(file.buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // header:1 keeps the raw grid, so the same header/row logic serves both formats.
  const grid = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  if (!grid.length) return { headers: [], records: [] };
  const head = findHeaderRow(grid, expect);
  const headers = (grid[head] || []).map((h) => String(h || '').trim());
  const records = grid.slice(head + 1)
    .filter((cells) => cells.some((c) => String(c ?? '').trim() !== ''))
    .map((cells, index) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] === undefined ? '' : String(cells[i]).trim(); });
      // The spreadsheet row number the error report quotes, so a person can
      // find the bad row in Excel.
      return { row: head + index + 2, data: obj };
    });
  return { headers, records };
}

module.exports = { parseCsv, parseCsvToObjects, toCsv, csvCell, readWorkbook, findHeaderRow };
