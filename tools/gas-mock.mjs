// Minimal in-memory emulation of the Apps Script services used by backend/Code.gs,
// so the real backend code can be unit-tested and served locally.
// Fidelity notes: like real Sheets, a date-looking string written to a cell that is not
// formatted as plain text ('@') is converted to a date and displayed as d/m/yyyy.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class Cell {
  constructor(v = '') { this.v = v; this.fmt = ''; this.note = ''; }
  display() {
    if (this.v instanceof Date) { const d = this.v; return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`; }
    return this.v === null || this.v === undefined ? '' : String(this.v);
  }
}

class Range {
  constructor(sheet, r, c, nr = 1, nc = 1) { Object.assign(this, { sheet, r, c, nr, nc }); }
  cells() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sheet.cell(this.r + i, this.c + j)); out.push(row); } return out; }
  getValues() { return this.cells().map((r) => r.map((c) => (c.v instanceof Date ? c.v : c.v ?? ''))); }
  getDisplayValues() { return this.cells().map((r) => r.map((c) => c.display())); }
  getValue() { return this.getValues()[0][0]; }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error(`setValues: dimensions ${vals.length}x${vals[0]?.length} != ${this.nr}x${this.nc}`);
    vals.forEach((row, i) => row.forEach((v, j) => this.sheet.write(this.r + i, this.c + j, v)));
    this.sheet.ss.writes++;
    return this;
  }
  setValue(v) { this.sheet.write(this.r, this.c, v); this.sheet.ss.writes++; return this; }
  setNumberFormat(f) { this.cells().flat().forEach((c) => { c.fmt = f; }); return this; }
  setNote(n) { this.sheet.cell(this.r, this.c).note = n; return this; }
  setDataValidation(rule) { this.sheet.validations[this.c] = rule.list; return this; }
  getDataValidation() {
    const list = this.sheet.validations[this.c];
    if (!list) return null;
    return { getCriteriaType: () => 'VALUE_IN_LIST', getCriteriaValues: () => [list] };
  }
}

class Sheet {
  constructor(ss, name, rows = []) {
    this.ss = ss; this.name = name; this.grid = []; this.validations = {}; this.frozen = 0; this.maxCols = 26;
    rows.forEach((r, i) => r.forEach((v, j) => { this.cell(i + 1, j + 1).v = v; }));
  }
  cell(r, c) {
    if (r < 1 || c < 1) throw new Error(`bad cell ${r},${c}`);
    if (c > this.maxCols) throw new Error(`column ${c} beyond max ${this.maxCols}`);
    while (this.grid.length < r) this.grid.push([]);
    const row = this.grid[r - 1];
    while (row.length < c) row.push(new Cell());
    return row[c - 1];
  }
  write(r, c, v) {
    const cell = this.cell(r, c);
    if (typeof v === 'string' && DATE_RE.test(v) && cell.fmt !== '@') cell.v = new Date(v + 'T00:00:00Z');
    else cell.v = v;
  }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getLastRow() { for (let i = this.grid.length; i > 0; i--) if (this.grid[i - 1].some((c) => c.display() !== '')) return i; return 0; }
  getLastColumn() { let m = 0; for (const row of this.grid) for (let j = row.length; j > m; j--) if (row[j - 1].display() !== '') { m = j; break; } return m; }
  getMaxColumns() { return this.maxCols; }
  getMaxRows() { return Math.max(1000, this.grid.length); }
  insertColumnAfter() { this.maxCols++; return this; }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  appendRow(vals) { const r = this.getLastRow() + 1; vals.forEach((v, j) => this.write(r, j + 1, v)); return this; }
  setFrozenRows(n) { this.frozen = n; return this; }
  // test helper
  table() { const lr = this.getLastRow(), lc = this.getLastColumn(); return lr && lc ? this.getRange(1, 1, lr, lc).getDisplayValues() : []; }
}

class Spreadsheet {
  constructor(name, id = 'ss-' + crypto.randomUUID().slice(0, 8)) { this.name = name; this.id = id; this.sheets = []; this.writes = 0; }
  getId() { return this.id; }
  getName() { return this.name; }
  getUrl() { return `https://docs.google.com/spreadsheets/d/${this.id}/edit`; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  // insertSheet(name, index) like Apps Script; an array as 2nd argument seeds rows (test helper)
  insertSheet(n, arg) { const s = new Sheet(this, n, Array.isArray(arg) ? arg : []); this.sheets.push(s); return s; }
  copy(name) { const c = new Spreadsheet(name); c.sheets = this.sheets.map((s) => { const t = new Sheet(c, s.name, s.table()); return t; }); registry.set(c.id, c); return c; }
}

const registry = new Map();

function zoned(d, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return Object.fromEntries(parts.map((x) => [x.type, x.value]));
}

export function createGas({ vocabRows, guideRows, statusList = ['New', 'Learning', 'Review', 'Mastered'] }) {
  const bound = new Spreadsheet('Ielts Words and Phrases', 'vocab');
  const vocab = bound.insertSheet('Vocab & Phrases', vocabRows);
  vocab.maxCols = Math.max(vocabRows[0]?.length || 14, 1); // like the real Sheet: no spare columns
  const statusCol = (vocabRows[0] || []).indexOf('Trạng thái') + 1;
  if (statusCol > 0) vocab.validations[statusCol] = statusList;
  bound.insertSheet('Hướng dẫn', guideRows || [['Mục', 'Quy tắc cập nhật'], ['Mục đích', 'demo']]);
  registry.set(bound.id, bound);
  const props = new Map();
  const logs = [];
  let locked = false;
  const ctx = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => bound,
      openById: (id) => { const s = registry.get(id); if (!s) throw new Error('not found'); return s; },
      create: (name) => { const s = new Spreadsheet(name); s.insertSheet('Sheet1'); registry.set(s.id, s); return s; },
      getUi: () => { throw new Error('No UI in this context'); },
      DataValidationCriteria: { VALUE_IN_LIST: 'VALUE_IN_LIST' },
      newDataValidation: () => {
        const r = { list: null, requireValueInList(l) { r.list = l; return r; }, setAllowInvalid() { return r; }, build() { return r; } };
        return r;
      },
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => { props.set(k, String(v)); },
      deleteProperty: (k) => { props.delete(k); },
    }) },
    LockService: { getScriptLock: () => ({
      waitLock: () => { if (locked) throw new Error('lock already held (re-entrancy bug)'); locked = true; },
      releaseLock: () => { locked = false; },
    }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        const p = zoned(d, tz);
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
      },
      // only the pattern Code.gs uses: 'yyyy-MM-dd HH:mm:ss', interpreted in `tz`
      parseDate: (str, tz, fmt) => {
        if (fmt !== 'yyyy-MM-dd HH:mm:ss') throw new Error('mock parseDate: unsupported format ' + fmt);
        const [y, mo, d, h, mi, se] = str.match(/\d+/g).map(Number);
        const wall = Date.UTC(y, mo - 1, d, h, mi, se);
        let t = wall;
        for (let k = 0; k < 2; k++) { const p = zoned(new Date(t), tz); t = wall - (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t); }
        return new Date(t);
      },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(String(s), 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
    },
    ContentService: {
      createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }),
      MimeType: { JSON: 'application/json' },
    },
    ScriptApp: { newTrigger: () => ({ timeBased: () => ({ everyWeeks: () => ({ create: () => ({}) }) }) }) },
    Logger: { log: (m) => logs.push(String(m)) },
  };
  vm.createContext(ctx);
  const code = fs.readFileSync(new URL('../backend/Code.gs', import.meta.url), 'utf8');
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return {
    ctx, bound, vocab, props, logs, call,
    data: () => registry.get(props.get('DATA_SPREADSHEET_ID')),
    token: () => props.get('API_TOKEN'),
  };
}

export function csvToRows(parseCSV, text) {
  return parseCSV(text).filter((r) => r.some((c) => c !== ''));
}
