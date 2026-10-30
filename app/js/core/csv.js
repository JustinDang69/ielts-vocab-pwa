import { headerIndex, FIELD_KEYS } from './fields.js';
import { norm } from './text.js';

// RFC 4180 CSV parser (handles quotes, escaped quotes, CRLF, newlines inside quotes).
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  text = String(text).replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Small stable hash (FNV-1a, 32-bit) for local-only IDs in CSV import mode.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

// Turns an exported "Vocab & Phrases" CSV into entries. Rows that already carry an
// "ID (app)" keep it; others get a local-only "csv-" ID derived from term+meaning+date
// (collisions get a numeric suffix). These local IDs are NOT the Sheet's IDs.
export function entriesFromCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { entries: [], warnings: ['File trống.'] };
  const idx = headerIndex(rows[0]);
  const warnings = [];
  if (idx.term === undefined) return { entries: [], warnings: ['Không thấy cột "Từ / Phrase".'] };
  for (const k of ['meaning', 'context']) if (idx[k] === undefined) warnings.push(`Thiếu cột ${k}.`);
  const seen = new Set();
  const entries = [];
  rows.slice(1).forEach((r, n) => {
    const get = (k) => (idx[k] === undefined ? '' : String(r[idx[k]] ?? '').trim());
    const term = get('term');
    if (!term) return;
    const fields = {};
    for (const k of FIELD_KEYS) fields[k] = get(k);
    let id = get('id');
    if (!id) {
      const base = 'csv-' + fnv1a(norm(term) + '|' + norm(fields.meaning) + '|' + fields.dateAdded);
      id = base;
      let s = 2;
      while (seen.has(id)) id = `${base}-${s++}`;
    } else if (seen.has(id)) {
      warnings.push(`ID trùng "${id}" ở hàng ${n + 2}; bỏ qua hàng sau.`);
      return;
    }
    seen.add(id);
    entries.push({ id, row: n + 2, fields, inSheet: true });
  });
  return { entries, warnings };
}
