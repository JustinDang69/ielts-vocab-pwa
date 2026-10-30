// Tests the real backend/Code.gs against the in-memory Apps Script emulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGas } from '../tools/gas-mock.mjs';

const HEAD = ['Ngày thêm', 'Từ / Phrase', 'Loại', 'Nghĩa trong ngữ cảnh', 'IPA', 'Câu gốc / Ngữ cảnh', 'Ví dụ bổ sung',
  'Cách dùng / Collocations', 'Kỹ năng nguồn', 'Chủ đề', 'Nguồn / Link', 'Trạng thái', 'Ngày ôn gần nhất', 'Ghi chú / Lỗi dễ nhầm'];
const row = (term, meaning, extra = {}) => HEAD.map((h) => ({ 'Ngày thêm': '2026-10-30', 'Từ / Phrase': term, 'Loại': 'Word', 'Nghĩa trong ngữ cảnh': meaning, 'Trạng thái': 'New', ...extra }[h] ?? ''));

function fresh() {
  const g = createGas({ vocabRows: [HEAD, row('amend', 'Sửa đổi'), row('tweak', 'Điều chỉnh nhẹ'), row('curb', 'Kiềm chế'), row('curb', 'Lề đường')] });
  g.ctx.setup();
  return g;
}
let n = 0;
const ev = (wordId, extra = {}) => ({ eventId: 'evt-' + String(++n).padStart(6, '0') + 'abc', type: 'review', wordId, ts: new Date().toISOString(), studyDate: '2026-11-01', deviceId: 'dev1', data: { outcome: 'correct' }, ...extra });

test('setup: additive ID column, original cells untouched, unique IDs (also for duplicate terms)', () => {
  const before = [HEAD, row('amend', 'Sửa đổi'), row('tweak', 'Điều chỉnh nhẹ'), row('curb', 'Kiềm chế'), row('curb', 'Lề đường')];
  const g = createGas({ vocabRows: before });
  g.ctx.setup();
  const t = g.vocab.table();
  assert.equal(t[0].length, HEAD.length + 1);
  assert.equal(t[0][HEAD.length], 'ID (app)');
  for (let r = 0; r < before.length; r++) for (let c = 0; c < HEAD.length; c++) assert.equal(t[r][c], before[r][c], `cell ${r},${c} changed`);
  const ids = t.slice(1).map((r) => r[HEAD.length]);
  assert.equal(new Set(ids).size, 4);
  ids.forEach((id) => assert.match(id, /^v-[0-9a-f]{8}$/));
  // guide row added once, even if setup runs again
  g.ctx.setup();
  const guide = g.bound.getSheetByName('Hướng dẫn').table();
  assert.equal(guide.filter((r) => r[0] === 'Cột ID (app)').length, 1);
  assert.deepEqual(g.vocab.table().slice(1).map((r) => r[HEAD.length]), ids, 'IDs are stable across runs');
});

test('auth: wrong or missing token is rejected', () => {
  const g = fresh();
  assert.equal(g.call({ action: 'ping' }).error, 'unauthorized');
  assert.equal(g.call({ action: 'ping', token: 'x'.repeat(40) }).error, 'unauthorized');
  assert.equal(g.call({ action: 'ping', token: g.token() }).ok, true);
});

test('new rows added by another chat (no ID) get IDs on next sync; copied IDs are re-assigned', () => {
  const g = fresh();
  const first = g.call({ action: 'sync', token: g.token(), sinceSeq: 0 });
  assert.equal(first.vocab.entries.length, 4);
  const idOf = Object.fromEntries(first.vocab.entries.map((e) => [e.fields.term + '|' + e.fields.meaning, e.id]));
  // another chat appends a row (no ID) and copies a row including its ID
  g.vocab.appendRow(row('benign', 'Lành tính'));
  const copy = row('amend', 'Sửa luật (nghĩa khác)'); copy.push(idOf['amend|Sửa đổi']);
  g.vocab.appendRow(copy);
  const second = g.call({ action: 'sync', token: g.token(), sinceSeq: 0 });
  assert.equal(second.ids.assigned, 1);
  assert.equal(second.ids.reassigned, 1);
  const byKey = Object.fromEntries(second.vocab.entries.map((e) => [e.fields.term + '|' + e.fields.meaning, e.id]));
  for (const k of Object.keys(idOf)) assert.equal(byKey[k], idOf[k], `existing ID for ${k} unchanged`);
  assert.notEqual(byKey['amend|Sửa luật (nghĩa khác)'], idOf['amend|Sửa đổi']);
  assert.ok(byKey['benign|Lành tính']);
  assert.ok(g.data().getSheetByName('Log').table().some((r) => r[1] === 'id_reassigned'));
});

test('events: idempotent push, validation, pull since seq, dates stay text', () => {
  const g = fresh();
  const s0 = g.call({ action: 'sync', token: g.token(), sinceSeq: 0 });
  const w = s0.vocab.entries[0].id;
  const a = ev(w), b = ev(w), bad = ev(w, { type: 'hack' });
  const r1 = g.call({ action: 'sync', token: g.token(), events: [a, b, bad], sinceSeq: 0 });
  assert.deepEqual(r1.push.accepted, [a.eventId, b.eventId]);
  assert.equal(r1.push.rejected[0].reason, 'bad_type');
  // retry after a lost response: same events again
  const r2 = g.call({ action: 'sync', token: g.token(), events: [a, b], sinceSeq: r1.pull.lastSeq });
  assert.deepEqual(r2.push.duplicates, [a.eventId, b.eventId]);
  assert.equal(r2.pull.events.length, 0);
  assert.equal(g.data().getSheetByName('Events').getLastRow(), 3);
  // another device pulls everything
  const r3 = g.call({ action: 'sync', token: g.token(), sinceSeq: 0 });
  assert.equal(r3.pull.events.length, 2);
  assert.equal(r3.pull.events[0].studyDate, '2026-11-01', 'studyDate not converted to a date');
  assert.deepEqual(r3.pull.events[0].data, { outcome: 'correct' });
});

test('state mirror: stale snapshot does not overwrite newer; guide rows added once', () => {
  const g = fresh();
  const w = g.call({ action: 'sync', token: g.token(), sinceSeq: 0 }).vocab.entries[0].id;
  g.call({ action: 'pushState', token: g.token(), states: [{ wordId: w, status: 'learning', sheetStatus: 'Learning', computedFromSeq: 5, lastStudyDate: '2026-11-01' }] });
  const r = g.call({ action: 'pushState', token: g.token(), states: [{ wordId: w, status: 'new', computedFromSeq: 2 }] });
  assert.equal(r.stale, 1);
  const ws = g.data().getSheetByName('WordState').table();
  assert.equal(ws[1][2], 'learning');
  g.call({ action: 'sync', token: g.token(), sinceSeq: 0 });
  const guide = g.bound.getSheetByName('Hướng dẫn').table().map((x) => x[0]);
  assert.equal(guide.filter((x) => x === 'App cập nhật trạng thái').length, 1);
  assert.equal(guide.filter((x) => x === 'Cột ID (app)').length, 1);
});

test('write-back (on by default): only changed rows/cells, never New, never overrides a Mastered set by others', () => {
  const g = createGas({ vocabRows: [HEAD, row('amend', 'Sửa đổi'), row('tweak', 'Điều chỉnh', { 'Trạng thái': 'Mastered' }), row('curb', 'Kiềm chế')] });
  g.ctx.setup();
  const es = g.call({ action: 'sync', token: g.token(), sinceSeq: 0 }).vocab.entries;
  const S = HEAD.indexOf('Trạng thái'), D = HEAD.indexOf('Ngày ôn gần nhất');
  const before = g.vocab.table();
  const push = (states) => g.call({ action: 'pushState', token: g.token(), states: states.map((x) => ({ computedFromSeq: 1, ...x })) });
  push([
    { wordId: es[0].id, sheetStatus: 'Learning', lastStudyDate: '2026-11-01' },
    { wordId: es[1].id, sheetStatus: 'Learning', lastStudyDate: '2026-11-01' },
    { wordId: es[2].id, sheetStatus: '' },
    { wordId: 'v-notinsheet', sheetStatus: 'Learning' },
  ]);
  let t = g.vocab.table();
  assert.equal(t[1][S], 'Learning');
  assert.equal(t[1][D], '2026-11-01', 'date stays text');
  assert.equal(t[2][S], 'Mastered', 'Mastered set by someone else is kept');
  assert.equal(t[3][S], 'New', 'never-studied word untouched');
  for (let r = 0; r < t.length; r++) for (let c = 0; c < t[0].length; c++) {
    if ((r === 1 || r === 2) && (c === S || c === D)) continue;
    assert.equal(t[r][c], before[r][c], `cell ${r},${c} must not change`);
  }
  // another chat edits the status; the app does not fight it while its own status is unchanged
  g.vocab.getRange(2, S + 1).setValue('Review');
  push([{ wordId: es[0].id, sheetStatus: 'Learning', lastStudyDate: '2026-11-01' }]);
  assert.equal(g.vocab.table()[1][S], 'Review');
  // ...but writes again when the app has news; and may replace a Mastered it wrote itself
  push([{ wordId: es[0].id, sheetStatus: 'Mastered', lastStudyDate: '2026-11-03' }]);
  assert.equal(g.vocab.table()[1][S], 'Mastered');
  push([{ wordId: es[0].id, sheetStatus: 'Review', lastStudyDate: '2026-11-02' }]);
  t = g.vocab.table();
  assert.equal(t[1][S], 'Review', 'forgotten word goes back to Review');
  assert.equal(t[1][D], '2026-11-03', 'last-review date never moves backwards');
  // can be switched off
  g.props.set('SHEET_WRITEBACK', 'off');
  push([{ wordId: es[0].id, sheetStatus: 'Learning', lastStudyDate: '2026-11-09' }]);
  assert.equal(g.vocab.table()[1][S], 'Review');
});
