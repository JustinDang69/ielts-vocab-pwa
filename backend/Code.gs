/**
 * IELTS Vocab PWA — Google Apps Script backend (bound to the "Ielts Words and Phrases" Sheet).
 *
 * Runs as the Sheet owner, so it reads the private Sheet with the owner's Google
 * authorisation. The PWA calls it over HTTPS with a pairing token that Justin types into
 * the app once (stored only on the device, never in source code).
 *
 * What it touches in the vocabulary Sheet:
 *   - adds ONE column "ID (app)" after the last column (once, additive),
 *   - fills IDs only in empty ID cells of rows that have a term, one cell at a time,
 *     re-checking the row just before writing,
 *   - writes "Trạng thái" (Learning / Review / Mastered, only values from the existing
 *     dropdown) and "Ngày ôn gần nhất" for a row when the app's state for it changes, so
 *     Max (ChatGPT) can read them. Never writes "New", never overwrites a "Mastered"
 *     that someone else set. Turn off with Script Property SHEET_WRITEBACK = off.
 *   - creates the tab "Speaking Results" (once). A Speaking chatbot appends one row per
 *     result there; on every sync each unprocessed row becomes exactly one "speaking"
 *     event (deterministic event ID) and the row's "Xử lý (app)" cell is marked.
 * Everything else (review history, schedule) lives in a SEPARATE
 * spreadsheet "IELTS Vocab App – Dữ liệu học", as the Sheet's "Hướng dẫn" requires.
 *
 * Sync contract: see docs/SYNC.md.
 */

var API_VERSION = 1;
var VOCAB_SHEET = 'Vocab & Phrases';
var GUIDE_SHEET = 'Hướng dẫn';
var ID_HEADER = 'ID (app)';
var HEADERS = {
  dateAdded: 'Ngày thêm', term: 'Từ / Phrase', type: 'Loại', meaning: 'Nghĩa trong ngữ cảnh', ipa: 'IPA',
  context: 'Câu gốc / Ngữ cảnh', example: 'Ví dụ bổ sung', usage: 'Cách dùng / Collocations',
  skill: 'Kỹ năng nguồn', topic: 'Chủ đề', source: 'Nguồn / Link', status: 'Trạng thái',
  lastReview: 'Ngày ôn gần nhất', note: 'Ghi chú / Lỗi dễ nhầm', id: ID_HEADER
};
var DEFAULT_STATUSES = ['New', 'Learning', 'Review', 'Mastered'];
var EVENT_TYPES = ['review', 'mastered', 'restore', 'flag_item'];
var EVENT_COLS = ['seq', 'eventId', 'type', 'wordId', 'ts', 'studyDate', 'deviceId', 'data', 'receivedAt'];
var STATE_COLS = ['wordId', 'term', 'status', 'sheetStatus', 'box', 'nextReview', 'lastStudyDate', 'successDates',
  'contextualDates', 'recallMet', 'maxPronunciation', 'maxUsage', 'archived', 'attempts', 'errors', 'hintsUsed',
  'computedFromSeq', 'deviceId', 'updatedAt', 'sheetStatusWritten'];
// (maxPronunciation / maxUsage hold the latest Speaking results; names kept so existing tabs stay aligned)
var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,40}$/;
var GUIDE_TEXT = 'Do app học từ vựng của Justin tự tạo (dạng v-xxxxxxxx) để nhận diện từng hàng. Khi thêm hàng mới: để trống ô này. ' +
  'Không sửa, xóa hoặc sao chép ID sang hàng khác. Khi bổ sung vào hàng cũ: giữ nguyên ID của hàng đó.';
var GUIDE_ROWS = [
  ['Cột ID (app)', GUIDE_TEXT],
  ['App cập nhật trạng thái', 'App học từ vựng tự ghi cột Trạng thái và Ngày ôn gần nhất sau khi Justin ôn: Learning = đang học; ' +
    'Review = đến hạn ôn lại; Mastered = đã tự nhớ đúng, không gợi ý, ở 3 ngày khác nhau (có 1 lần trong câu). ' +
    'Max có thể đọc hai cột này để chọn từ luyện nói. Hàng mới vẫn ghi New như cũ; app không ghi đè Mastered do người hoặc chat khác đặt.'],
  ['Tab Speaking Results', 'Chatbot Speaking ghi mỗi kết quả thành MỘT HÀNG MỚI ở cuối tab Speaking Results (ID (app) lấy từ tab Vocab & Phrases). ' +
    'Không sửa, xóa hay sắp xếp hàng cũ; không ghi vào cột "Xử lý (app)" — app tự đánh dấu khi đã nhận. Không sửa Trạng thái/Ngày ôn gần nhất.']
];
var MAX_EVENTS_PER_CALL = 500;
var MAX_PULL = 1000;
var APP_TZ = 'Australia/Sydney';

// Speaking results tab (in the vocabulary spreadsheet, so a chatbot with access to it can append).
var SPEAKING_SHEET = 'Speaking Results';
var SPEAKING_HEADERS = {
  id: 'ID (app)', term: 'Từ / Phrase', time: 'Thời gian', usage: 'Cách dùng', support: 'Mức hỗ trợ',
  pronunciation: 'Phát âm', evidence: 'Bằng chứng phát âm', sentence: 'Câu Justin nói', feedback: 'Nhận xét',
  source: 'Nguồn', processed: 'Xử lý (app)'
};
var SPEAKING_ORDER = ['id', 'term', 'time', 'usage', 'support', 'pronunciation', 'evidence', 'sentence', 'feedback', 'source', 'processed'];
// Accepted spellings (compared without accents/case). Canonical value first.
var SPEAKING_VALUES = {
  usage: { pass: ['pass', 'dat', 'ok'], needs_work: ['needs_work', 'needs work', 'chua dat', 'can luyen', 'fail'],
    not_assessed: ['not_assessed', 'not assessed', 'chua danh gia', 'n/a', 'na', '-', ''] },
  support: { none: ['none', 'khong', 'tu noi', 'khong goi y', 'no'], hint: ['hint', 'goi y', 'co goi y'],
    model: ['model', 'theo mau', 'doc theo mau', 'nhac lai', 'repeat'], unknown: [''] },
  evidence: { audio: ['audio', 'am thanh', 'giong noi', 'voice'], transcript: ['transcript', 'text', 'van ban'], none: ['none', 'khong', ''] }
};
SPEAKING_VALUES.pronunciation = SPEAKING_VALUES.usage;
var SPEAKING_NOTES = {
  id: 'Bắt buộc. Lấy đúng ID (app) của từ trong tab Vocab & Phrases (dạng v-xxxxxxxx).',
  time: 'YYYY-MM-DD HH:mm, giờ Australia/Sydney.',
  usage: 'pass = tự dùng đúng nghĩa trong câu; needs_work = dùng sai/chưa tự nhiên; not_assessed = chưa đánh giá.',
  support: 'none = tự nói, không gợi ý; hint = có gợi ý (nghĩa, chữ đầu, khung câu); model = nhắc lại/đọc theo mẫu.',
  pronunciation: 'pass / needs_work chỉ khi bot thật sự nghe audio. Chỉ có transcript → not_assessed.',
  evidence: 'audio = bot nghe giọng nói; transcript = chỉ có chữ; none = không có.',
  processed: 'App tự ghi. Chatbot để trống.'
};

// ---------------------------------------------------------------- menu & setup

function onOpen() {
  SpreadsheetApp.getUi().createMenu('IELTS App')
    .addItem('Cài đặt / kiểm tra', 'setup')
    .addItem('Gán ID cho hàng mới', 'menuAssignIds')
    .addItem('Hiện mã kết nối (token)', 'showToken')
    .addItem('Đổi mã kết nối (token)', 'rotateToken')
    .addItem('Sao lưu dữ liệu học ngay', 'backupNow')
    .addToUi();
}

/** Run once from the Apps Script editor (and again any time; it is idempotent). */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', newToken_());
  props.deleteProperty('WRITEBACK_STATUS'); // replaced by SHEET_WRITEBACK (on unless set to "off")
  props.deleteProperty('WRITEBACK_LAST_REVIEW');
  var data = dataSpreadsheet_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var res;
  try {
    ensureIdColumn_(vocabSheet_());
    ensureGuideRows_();
    ensureSpeakingTab_();
    res = assignIds_();
  } finally {
    lock.releaseLock();
  }
  var msg = 'Đã cài đặt.\n' +
    'Gán ID mới: ' + res.assigned + ', ID trùng đã đổi: ' + res.reassigned + '\n' +
    'File dữ liệu học: ' + data.getUrl() + '\n' +
    'Mã kết nối (token) để nhập vào app: ' + props.getProperty('API_TOKEN');
  Logger.log(msg);
  log_('setup', JSON.stringify(res));
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from editor: see Execution log */ }
  return { ok: true, assigned: res.assigned, reassigned: res.reassigned, dataUrl: data.getUrl() };
}

function menuAssignIds() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var r = assignIds_();
    try { SpreadsheetApp.getUi().alert('Gán ID mới: ' + r.assigned + ', ID trùng đã đổi: ' + r.reassigned); } catch (e) {}
  } finally { lock.releaseLock(); }
}

function showToken() {
  var t = PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '(chưa có — chạy setup)';
  Logger.log(t);
  try { SpreadsheetApp.getUi().alert('Mã kết nối: ' + t); } catch (e) {}
  return t;
}

function rotateToken() {
  var t = newToken_();
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', t);
  log_('token_rotated', '');
  Logger.log('Mã mới: ' + t);
  try { SpreadsheetApp.getUi().alert('Mã mới (nhập lại vào app): ' + t); } catch (e) {}
  return t;
}

/** Copies the app-data spreadsheet into Drive. Optional weekly trigger: installWeeklyBackup(). */
function backupNow() {
  var ss = dataSpreadsheet_();
  var name = ss.getName() + ' – backup ' + Utilities.formatDate(new Date(), 'Australia/Sydney', 'yyyy-MM-dd HHmm');
  var copy = ss.copy(name);
  log_('backup', copy.getId());
  return copy.getId();
}

function installWeeklyBackup() {
  ScriptApp.newTrigger('backupNow').timeBased().everyWeeks(1).create();
}

// ---------------------------------------------------------------- HTTP API

function doGet() {
  return json_({ ok: true, service: 'ielts-vocab-backend', apiVersion: API_VERSION, note: 'POST only' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  if (!checkToken_(req && req.token)) return json_({ ok: false, error: 'unauthorized' });
  try {
    if (req.action === 'ping') return json_({ ok: true, apiVersion: API_VERSION, serverTime: new Date().toISOString() });
    if (req.action === 'sync') return json_(sync_(req));
    if (req.action === 'pushState') return json_(pushState_(req));
    return json_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    log_('error', String(err && err.stack || err));
    return json_({ ok: false, error: 'server_error', message: String(err && err.message || err) });
  }
}

/**
 * One round trip: assign missing IDs, append the client's new events (idempotent by
 * eventId), return events after `sinceSeq` and the current vocabulary.
 */
function sync_(req) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ids = assignIds_();
    ensureGuideRows_();
    var vocab = readVocab_();
    var known = {};
    vocab.entries.forEach(function (x) { known[x.id] = true; });
    var push = appendEvents_(Array.isArray(req.events) ? req.events.slice(0, MAX_EVENTS_PER_CALL) : [], known, req.deviceId);
    var speaking;
    try {
      speaking = ingestSpeaking_(vocab.entries, known);
    } catch (err) {
      log_('speaking_error', String(err && err.stack || err));
      speaking = { error: String(err && err.message || err) };
    }
    var pull = readEventsSince_(Number(req.sinceSeq) || 0);
    return {
      ok: true, apiVersion: API_VERSION, serverTime: new Date().toISOString(),
      ids: ids, vocab: vocab, push: push, speaking: speaking, pull: pull
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- vocabulary

function vocabSheet_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(VOCAB_SHEET);
  if (!sh) throw new Error('Không thấy tab "' + VOCAB_SHEET + '"');
  return sh;
}

function normHeader_(h) {
  return String(h == null ? '' : h).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function headerIndex_(sh) {
  var lastCol = sh.getLastColumn();
  var row = lastCol ? sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
  var wanted = {};
  Object.keys(HEADERS).forEach(function (k) { wanted[normHeader_(HEADERS[k])] = k; });
  var idx = {};
  row.forEach(function (h, i) {
    var k = wanted[normHeader_(h)];
    if (k && idx[k] === undefined) idx[k] = i;
  });
  return idx;
}

/** Adds the ID column after the last used column if it doesn't exist. Returns 1-based column. */
function ensureIdColumn_(sh) {
  var idx = headerIndex_(sh);
  if (idx.id !== undefined) return idx.id + 1;
  var col = sh.getLastColumn() + 1;
  if (sh.getMaxColumns() < col) sh.insertColumnAfter(sh.getMaxColumns());
  var cell = sh.getRange(1, col);
  cell.setValue(ID_HEADER);
  cell.setNote(GUIDE_TEXT);
  log_('id_column_added', 'column ' + col);
  return col;
}

/** Appends the app's explanation rows to "Hướng dẫn" if they are missing (never edits others). */
function ensureGuideRows_() {
  var g = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GUIDE_SHEET);
  if (!g) return;
  var last = g.getLastRow();
  var have = {};
  (last ? g.getRange(1, 1, last, 1).getDisplayValues() : []).forEach(function (r) { have[String(r[0]).trim()] = true; });
  GUIDE_ROWS.forEach(function (row) {
    if (have[row[0]]) return;
    last++;
    g.getRange(last, 1, 1, 2).setValues([row]);
    log_('guide_row_added', row[0] + ' (row ' + last + ')');
  });
}

/**
 * Gives every row that has a term but no (valid, unique) ID a new ID.
 * - First occurrence of a duplicated ID keeps it; later copies get a new one (logged).
 * - Each write re-reads the row first; if it changed in the meantime, it is skipped
 *   and handled by the next sync.
 * Caller must hold the script lock.
 */
function assignIds_() {
  var sh = vocabSheet_();
  var idCol = ensureIdColumn_(sh);
  var idx = headerIndex_(sh);
  if (idx.term === undefined) throw new Error('Không thấy cột "' + HEADERS.term + '"');
  var termCol = idx.term + 1;
  var last = sh.getLastRow();
  var out = { assigned: 0, reassigned: 0, skipped: 0 };
  if (last < 2) return out;
  var terms = sh.getRange(2, termCol, last - 1, 1).getDisplayValues();
  var ids = sh.getRange(2, idCol, last - 1, 1).getDisplayValues();
  var seen = {};    // every ID present anywhere (even on rows without a term): never handed out again
  var claimed = {}; // IDs already owned by an earlier row
  var todo = [];
  ids.forEach(function (r) { var v = String(r[0]).trim(); if (v) seen['_' + v] = true; });
  for (var i = 0; i < terms.length; i++) {
    var term = String(terms[i][0]).trim();
    var id = String(ids[i][0]).trim();
    if (!term) continue;
    if (id && ID_RE.test(id) && !claimed['_' + id]) { claimed['_' + id] = true; continue; }
    todo.push({ row: i + 2, term: term, oldId: id });
  }
  todo.forEach(function (t) {
    var curTerm = String(sh.getRange(t.row, termCol).getDisplayValue()).trim();
    var curId = String(sh.getRange(t.row, idCol).getDisplayValue()).trim();
    if (curTerm !== t.term || curId !== t.oldId) { out.skipped++; return; }
    var nid = newId_(seen);
    var cell = sh.getRange(t.row, idCol);
    cell.setNumberFormat('@');
    cell.setValue(nid);
    seen['_' + nid] = true;
    if (t.oldId) {
      out.reassigned++;
      log_('id_reassigned', 'row ' + t.row + ' "' + t.term + '": ' + t.oldId + ' -> ' + nid);
    } else {
      out.assigned++;
    }
  });
  return out;
}

function readVocab_() {
  var sh = vocabSheet_();
  var idx = headerIndex_(sh);
  var last = sh.getLastRow(), lastCol = sh.getLastColumn();
  var warnings = [];
  Object.keys(HEADERS).forEach(function (k) { if (idx[k] === undefined) warnings.push('Thiếu cột "' + HEADERS[k] + '"'); });
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, lastCol).getDisplayValues() : [];
  var entries = [];
  var pendingIds = 0;
  rows.forEach(function (r, i) {
    var get = function (k) { return idx[k] === undefined ? '' : String(r[idx[k]] == null ? '' : r[idx[k]]).trim(); };
    var term = get('term');
    if (!term) return;
    var id = get('id');
    if (!id) { pendingIds++; return; }
    var fields = {};
    Object.keys(HEADERS).forEach(function (k) { if (k !== 'id') fields[k] = get(k); });
    entries.push({ id: id, row: i + 2, fields: fields });
  });
  return { entries: entries, warnings: warnings, pendingIds: pendingIds, statusOptions: statusOptions_(sh, idx) };
}

function statusOptions_(sh, idx) {
  if (idx.status === undefined || sh.getLastRow() < 2) return DEFAULT_STATUSES;
  try {
    var dv = sh.getRange(2, idx.status + 1).getDataValidation();
    if (dv && String(dv.getCriteriaType()) === String(SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST)) {
      var vals = dv.getCriteriaValues()[0];
      if (vals && vals.length) return vals.map(String);
    }
  } catch (e) { /* fall through */ }
  return DEFAULT_STATUSES;
}

// ---------------------------------------------------------------- app data spreadsheet

function dataSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DATA_SPREADSHEET_ID');
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('IELTS Vocab App – Dữ liệu học (đừng sửa tay)');
    props.setProperty('DATA_SPREADSHEET_ID', ss.getId());
    var first = ss.getSheets()[0];
    first.setName('Events');
  }
  ensureTab_(ss, 'Events', EVENT_COLS);
  ensureTab_(ss, 'WordState', STATE_COLS);
  ensureTab_(ss, 'Log', ['time', 'action', 'detail']);
  ensureTab_(ss, 'README', ['Giải thích']);
  var readme = ss.getSheetByName('README');
  if (readme.getLastRow() < 2) {
    readme.getRange(2, 1, 4, 1).setValues([
      ['Events: nhật ký sự kiện học (chỉ thêm, không sửa/xóa). Đây là dữ liệu gốc của lịch sử học.'],
      ['WordState: bản tóm tắt dễ đọc (tính lại từ Events), gồm ngày ôn tiếp theo và kết quả Max.'],
      ['Log: ghi chú kỹ thuật (gán ID, đổi ID trùng, lỗi).'],
      ['Từ vựng nằm trong file "Ielts Words and Phrases"; file này chỉ lưu kết quả học.']
    ]);
  }
  return ss;
}

function ensureTab_(ss, name, cols) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  } else {
    // columns added in later versions are appended to the header (existing ones never move)
    var have = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    for (var i = have.length; i < cols.length; i++) {
      if (sh.getMaxColumns() < i + 1) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(1, i + 1).setValue(cols[i]);
    }
  }
  return sh;
}

function log_(action, detail) {
  try {
    var sh = dataSpreadsheet_().getSheetByName('Log');
    sh.appendRow([new Date().toISOString(), action, String(detail).slice(0, 5000)]);
  } catch (e) { Logger.log(action + ' ' + detail); }
}

// ---------------------------------------------------------------- events

// `trusted` = created by this script (speaking ingestion); devices can never send "speaking" events.
function validateEvent_(ev, known, trusted) {
  if (!ev || typeof ev !== 'object') return 'not_object';
  if (typeof ev.eventId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(ev.eventId)) return 'bad_eventId';
  if (EVENT_TYPES.indexOf(ev.type) < 0 && !(trusted && ev.type === 'speaking')) return 'bad_type';
  if (typeof ev.wordId !== 'string' || !ev.wordId || ev.wordId.length > 64) return 'bad_wordId';
  var t = Date.parse(ev.ts);
  if (!ev.ts || isNaN(t)) return 'bad_ts';
  if (t > Date.now() + 36 * 3600 * 1000) return 'ts_in_future';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.studyDate || '')) return 'bad_studyDate';
  var d = ev.data || {};
  if (typeof d !== 'object') return 'bad_data';
  if (JSON.stringify(d).length > 8000) return 'data_too_large';
  return null;
}

function eventsSheet_() { return dataSpreadsheet_().getSheetByName('Events'); }

function appendEvents_(events, known, deviceId, trusted) {
  var res = { accepted: [], duplicates: [], rejected: [] };
  if (!events.length) return res;
  var sh = eventsSheet_();
  var last = sh.getLastRow();
  var existing = {};
  var lastSeq = 0;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    vals.forEach(function (r) { existing[String(r[1])] = true; lastSeq = Math.max(lastSeq, Number(r[0]) || 0); });
  }
  var rows = [];
  var now = new Date().toISOString();
  events.forEach(function (ev) {
    if (ev && existing[ev.eventId]) { res.duplicates.push(ev.eventId); return; }
    var why = validateEvent_(ev, known, trusted);
    if (why) { res.rejected.push({ eventId: ev && ev.eventId, reason: why }); return; }
    existing[ev.eventId] = true;
    lastSeq++;
    rows.push([lastSeq, ev.eventId, ev.type, ev.wordId, ev.ts, ev.studyDate, String(ev.deviceId || deviceId || '').slice(0, 64),
      JSON.stringify(ev.data || {}), now]);
    res.accepted.push(ev.eventId);
  });
  if (rows.length) {
    var rg = sh.getRange(last + 1, 1, rows.length, EVENT_COLS.length);
    rg.setNumberFormat('@'); // keep ts/studyDate as text: Sheets must not turn them into dates
    rg.setValues(rows);
  }
  return res;
}

function readEventsSince_(sinceSeq) {
  var sh = eventsSheet_();
  var last = sh.getLastRow();
  var out = [];
  var lastSeq = sinceSeq;
  var more = false;
  if (last >= 2) {
    // Studydate/ts columns are forced to text so Sheets never converts them to dates.
    var vals = sh.getRange(2, 1, last - 1, EVENT_COLS.length).getDisplayValues();
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i];
      var seq = Number(r[0]);
      if (!(seq > sinceSeq)) continue;
      if (out.length >= MAX_PULL) { more = true; break; }
      var data = {};
      try { data = JSON.parse(r[7] || '{}'); } catch (e) { data = { _unparsed: r[7] }; }
      out.push({ seq: seq, eventId: r[1], type: r[2], wordId: r[3], ts: r[4], studyDate: r[5], deviceId: r[6], data: data });
      lastSeq = Math.max(lastSeq, seq);
    }
  }
  return { events: out, lastSeq: lastSeq, more: more };
}

// ---------------------------------------------------------------- Speaking results

function ensureSpeakingTab_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SPEAKING_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(SPEAKING_SHEET, ss.getSheets().length);
  var heads = SPEAKING_ORDER.map(function (k) { return SPEAKING_HEADERS[k]; });
  sh.getRange(1, 1, 1, heads.length).setValues([heads]);
  sh.setFrozenRows(1);
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, 1, rows, heads.length).setNumberFormat('@'); // keep times/IDs as plain text
  ['usage', 'support', 'pronunciation', 'evidence'].forEach(function (k) {
    var list = Object.keys(SPEAKING_VALUES[k]).filter(function (v) { return v !== 'unknown'; });
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build();
    sh.getRange(2, SPEAKING_ORDER.indexOf(k) + 1, rows, 1).setDataValidation(rule);
  });
  Object.keys(SPEAKING_NOTES).forEach(function (k) {
    sh.getRange(1, SPEAKING_ORDER.indexOf(k) + 1).setNote(SPEAKING_NOTES[k]);
  });
  log_('speaking_tab_created', SPEAKING_SHEET);
  return sh;
}

function plain_(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Canonical value for a Speaking field, or null if the text is not an accepted spelling. */
function speakingValue_(field, raw) {
  var v = plain_(raw);
  var map = SPEAKING_VALUES[field];
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) if (map[keys[i]].indexOf(v) >= 0) return keys[i];
  return null;
}

function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/** Accepts a Sheets date value, "YYYY-MM-DD", "YYYY-MM-DD HH:mm[:ss]" (Sydney time) or ISO with offset. */
function speakingTime_(raw, shown, now) {
  var d = null;
  if (Object.prototype.toString.call(raw) === '[object Date]' && !isNaN(raw)) d = raw;
  else {
    var s = String(shown || '').trim();
    if (!s) return { missing: true, ts: now.toISOString(), studyDate: Utilities.formatDate(now, APP_TZ, 'yyyy-MM-dd') };
    var m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      var hh = m[2] ? ('0' + m[2]).slice(-2) : '12';
      d = Utilities.parseDate(m[1] + ' ' + hh + ':' + (m[3] || '00') + ':' + (m[4] || '00'), APP_TZ, 'yyyy-MM-dd HH:mm:ss');
    } else if (/(Z|[+-]\d{2}:?\d{2})$/.test(s) && !isNaN(Date.parse(s))) {
      d = new Date(s);
    } else {
      return { error: 'Thời gian không đúng dạng YYYY-MM-DD HH:mm' };
    }
  }
  if (d.getTime() > now.getTime() + 3600 * 1000) return { error: 'Thời gian nằm ở tương lai' };
  return { ts: d.toISOString(), studyDate: Utilities.formatDate(d, APP_TZ, 'yyyy-MM-dd') };
}

/**
 * Turns every unprocessed row of "Speaking Results" into one "speaking" event.
 * Exactly-once: (1) a row whose "Xử lý (app)" cell is filled is skipped; (2) the event ID is
 * a hash of the row's content, so even if marking the cell failed, re-processing is a
 * duplicate that appendEvents_ ignores. Rows with problems are marked "✗ …" and not counted;
 * clearing that cell after fixing the row makes the app read it again.
 * Caller must hold the script lock.
 */
function ingestSpeaking_(entries, known) {
  var out = { accepted: 0, duplicates: 0, errors: 0, tests: 0 };
  var sh = ensureSpeakingTab_();
  var last = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (last < 2) return out;
  var head = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var col = {};
  var wanted = {};
  SPEAKING_ORDER.forEach(function (k) { wanted[normHeader_(SPEAKING_HEADERS[k])] = k; });
  head.forEach(function (h, i) { var k = wanted[normHeader_(h)]; if (k && col[k] === undefined) col[k] = i; });
  if (col.id === undefined || col.processed === undefined) return { error: 'Tab Speaking Results thiếu cột "ID (app)" hoặc "Xử lý (app)"' };
  var shown = sh.getRange(2, 1, last - 1, lastCol).getDisplayValues();
  var rawTime = col.time !== undefined ? sh.getRange(2, col.time + 1, last - 1, 1).getValues() : null;
  var byId = {}, byTerm = {};
  entries.forEach(function (e) {
    byId[e.id] = e;
    var t = plain_(e.fields.term);
    (byTerm[t] = byTerm[t] || []).push(e);
  });
  var now = new Date();
  var stamp = Utilities.formatDate(now, APP_TZ, 'yyyy-MM-dd HH:mm');
  var marks = [], pending = [];
  for (var i = 0; i < shown.length; i++) {
    var r = shown[i];
    var get = function (k) { return col[k] === undefined ? '' : String(r[col[k]] == null ? '' : r[col[k]]).trim(); };
    if (get('processed')) continue;
    var row = { n: i + 2, id: get('id'), usageRaw: get('usage') };
    var term = get('term'), pronRaw = get('pronunciation');
    if (!row.id && !term && !row.usageRaw && !pronRaw) continue; // empty row
    var fail = function (why) { out.errors++; marks.push({ row: row, text: '✗ ' + why }); };
    if (/^test/i.test(row.id)) { out.tests++; marks.push({ row: row, text: '🧪 App đã nhận hàng thử lúc ' + stamp + ' (không tính vào tiến độ)' }); continue; }
    var entry = row.id ? byId[row.id] : null;
    if (row.id && !entry) { fail('ID không có trong Vocab & Phrases'); continue; }
    if (!row.id) {
      var cands = byTerm[plain_(term)] || [];
      if (cands.length !== 1) { fail(cands.length ? 'Thiếu ID (app): có nhiều hàng cùng từ này' : 'Thiếu ID (app) và không tìm thấy từ'); continue; }
      entry = cands[0];
    } else if (term && plain_(term) !== plain_(entry.fields.term)) {
      fail('Từ không khớp với ID (ID này là "' + entry.fields.term + '")'); continue;
    }
    var v = {
      usage: speakingValue_('usage', row.usageRaw), pronunciation: speakingValue_('pronunciation', pronRaw),
      support: speakingValue_('support', get('support')), evidence: speakingValue_('evidence', get('evidence'))
    };
    var bad = Object.keys(v).filter(function (k) { return v[k] === null; }).map(function (k) { return SPEAKING_HEADERS[k]; });
    if (bad.length) { fail('Giá trị không hợp lệ ở cột: ' + bad.join(', ')); continue; }
    if (v.usage === 'not_assessed' && v.pronunciation === 'not_assessed') { fail('Chưa có kết quả Cách dùng hoặc Phát âm'); continue; }
    var t = speakingTime_(rawTime ? rawTime[i][0] : '', get('time'), now);
    if (t.error) { fail(t.error); continue; }
    var notes = [];
    // a transcript alone cannot establish pronunciation quality
    if (v.pronunciation !== 'not_assessed' && v.evidence !== 'audio') { v.pronunciation = 'not_assessed'; notes.push('phát âm không có audio → chưa đánh giá'); }
    if (v.support === 'unknown') notes.push('thiếu Mức hỗ trợ → không tính là tự nói');
    if (t.missing) notes.push('không có Thời gian → dùng lúc app nhận');
    if (!row.id) notes.push('ID suy ra từ cột Từ / Phrase: ' + entry.id);
    var data = {
      usage: v.usage, pronunciation: v.pronunciation, evidence: v.evidence, support: v.support,
      sentence: get('sentence').slice(0, 500), feedback: get('feedback').slice(0, 1000),
      source: get('source').slice(0, 80) || SPEAKING_SHEET, sheetRow: row.n, time: get('time').slice(0, 40)
    };
    var fingerprint = [entry.id, get('time'), row.usageRaw, get('support'), pronRaw, get('evidence'), data.sentence, data.feedback, data.source].join('\u241F');
    pending.push({
      row: row, notes: notes,
      ev: { eventId: 'sp-' + sha256Hex_(fingerprint).slice(0, 40), type: 'speaking', wordId: entry.id, ts: t.ts, studyDate: t.studyDate, deviceId: 'speaking-tab', data: data }
    });
  }
  if (pending.length) {
    var res = appendEvents_(pending.map(function (p) { return p.ev; }), known, 'speaking-tab', true);
    var rejected = {};
    res.rejected.forEach(function (x) { rejected[x.eventId] = x.reason; });
    pending.forEach(function (p) {
      var extra = p.notes.length ? ' · ' + p.notes.join('; ') : '';
      if (res.accepted.indexOf(p.ev.eventId) >= 0) { out.accepted++; marks.push({ row: p.row, text: '✓ App đã nhận ' + stamp + extra }); }
      else if (res.duplicates.indexOf(p.ev.eventId) >= 0) { out.duplicates++; marks.push({ row: p.row, text: '✓ Đã nhận trước đó (không tính lại)' }); }
      else { out.errors++; marks.push({ row: p.row, text: '✗ ' + (rejected[p.ev.eventId] || 'không ghi được') }); }
    });
  }
  // Mark single cells, only if the row still holds what was read (a chatbot may be writing).
  marks.forEach(function (m) {
    var cell = sh.getRange(m.row.n, col.processed + 1);
    if (String(cell.getDisplayValue()).trim()) return;
    if (String(sh.getRange(m.row.n, col.id + 1).getDisplayValue()).trim() !== m.row.id) return;
    if (col.usage !== undefined && String(sh.getRange(m.row.n, col.usage + 1).getDisplayValue()).trim() !== m.row.usageRaw) return;
    cell.setValue(m.text);
  });
  return out;
}

// ---------------------------------------------------------------- derived state mirror + optional write-back

/**
 * Upserts the readable WordState mirror. A row is only replaced by a snapshot computed
 * from at least as many server events (computedFromSeq), so a stale device can't
 * overwrite newer state. Then writes changed statuses back into the vocabulary Sheet.
 */
function pushState_(req) {
  var states = Array.isArray(req.states) ? req.states.slice(0, 2000) : [];
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sh = dataSpreadsheet_().getSheetByName('WordState');
    var last = sh.getLastRow();
    var table = last >= 2 ? sh.getRange(2, 1, last - 1, STATE_COLS.length).getDisplayValues() : [];
    var at = {};
    table.forEach(function (r, i) { at[r[0]] = i; });
    var seqCol = STATE_COLS.indexOf('computedFromSeq');
    var wCol = STATE_COLS.indexOf('sheetStatusWritten');
    var updated = 0, stale = 0;
    var now = new Date().toISOString();
    var fresh = [];
    states.forEach(function (s) {
      if (!s || typeof s.wordId !== 'string') return;
      var prev = at[s.wordId] !== undefined ? table[at[s.wordId]] : null;
      if (prev && Number(prev[seqCol] || 0) > Number(s.computedFromSeq || 0)) { stale++; return; }
      var row = STATE_COLS.map(function (c) {
        if (c === 'updatedAt') return now;
        if (c === 'deviceId') return String(req.deviceId || '');
        if (c === 'sheetStatusWritten') return prev ? prev[wCol] : '';
        var v = s[c];
        return v === undefined || v === null ? '' : String(v);
      });
      if (prev) table[at[s.wordId]] = row;
      else { at[s.wordId] = table.length; table.push(row); }
      fresh.push({ s: s, row: row });
      updated++;
    });
    var wb = writeBack_(fresh, wCol);
    if (table.length) {
      var range = sh.getRange(2, 1, table.length, STATE_COLS.length);
      range.setNumberFormat('@');
      range.setValues(table);
    }
    return { ok: true, updated: updated, stale: stale, writeback: wb };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Writes "Trạng thái" when the app's status for a word changed since the app last wrote it
 * (so later edits by other chats are respected until the app has news), and moves
 * "Ngày ôn gần nhất" forward. Rules: only dropdown values; never "New"; never replaces a
 * "Mastered" the app didn't write itself. Single cells, on the row whose ID matches.
 */
function writeBack_(fresh, wCol) {
  var out = { enabled: PropertiesService.getScriptProperties().getProperty('SHEET_WRITEBACK') !== 'off', written: 0 };
  if (!out.enabled || !fresh.length) return out;
  var sh = vocabSheet_();
  var idx = headerIndex_(sh);
  var last = sh.getLastRow();
  if (last < 2 || idx.id === undefined) return out;
  var ids = sh.getRange(2, idx.id + 1, last - 1, 1).getDisplayValues();
  var rowOf = {};
  ids.forEach(function (r, i) { if (r[0]) rowOf[String(r[0]).trim()] = i + 2; });
  var options = statusOptions_(sh, idx);
  fresh.forEach(function (f) {
    var s = f.s;
    var row = rowOf[s.wordId];
    if (!row) return;
    // re-verify the row still carries this ID right before writing
    if (String(sh.getRange(row, idx.id + 1).getDisplayValue()).trim() !== s.wordId) return;
    var want = s.sheetStatus;
    var lastWritten = f.row[wCol];
    if (idx.status !== undefined && want && want !== 'New' && options.indexOf(want) >= 0 && want !== lastWritten) {
      var c = sh.getRange(row, idx.status + 1);
      var cur = String(c.getDisplayValue()).trim();
      if (cur === want) f.row[wCol] = want;
      else if (!(cur === 'Mastered' && lastWritten !== 'Mastered')) { c.setValue(want); f.row[wCol] = want; out.written++; }
    }
    if (idx.lastReview !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(s.lastStudyDate || '')) {
      var d = sh.getRange(row, idx.lastReview + 1);
      var curD = String(d.getDisplayValue()).trim();
      if (!curD || curD < s.lastStudyDate) { d.setNumberFormat('@'); d.setValue(s.lastStudyDate); out.written++; }
    }
  });
  return out;
}

// ---------------------------------------------------------------- helpers

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(t) {
  var real = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!real || typeof t !== 'string' || t.length !== real.length) return false;
  var diff = 0;
  for (var i = 0; i < real.length; i++) diff |= real.charCodeAt(i) ^ t.charCodeAt(i);
  return diff === 0;
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
}

function newId_(seen) {
  for (var n = 0; n < 50; n++) {
    var id = 'v-' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    if (!seen['_' + id]) return id;
  }
  throw new Error('Could not generate a unique ID');
}
