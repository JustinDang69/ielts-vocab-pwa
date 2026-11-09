// Run: node --test tests/
// Optional: set VOCAB_CSV=path/to/exported.csv to also run the fairness checks on a real Sheet export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { findTerm, mask, gloss, similarMeaning, normAnswer } from '../app/js/core/text.js';
import { computeStates, DEFAULT_CONFIG, stateSnapshot } from '../app/js/core/state.js';
import { buildItem, gradeTyped, available } from '../app/js/core/exercises.js';
import { planSession, newSession, recordAnswer, currentItem } from '../app/js/core/session.js';
import { entriesFromCSV, parseCSV } from '../app/js/core/csv.js';
import { addDays } from '../app/js/core/dates.js';
import { DEMO_ENTRIES } from '../app/js/demo-data.js';

const mkEntry = (id, term, meaning, extra = {}) => ({ id, inSheet: true, fields: { term, meaning, context: '', example: '', usage: '', note: '', type: 'Word', ...extra } });

test('term matching tolerates inflection and possessives', () => {
  assert.equal(findTerm('it stems from humans’ tendency to personify', 'human tendency').surface, 'humans’ tendency');
  assert.equal(findTerm('The detective outwitted the thief.', 'outwit').surface, 'outwitted');
  assert.equal(findTerm('Inspectors scrutinised every document', 'scrutinise').surface, 'scrutinised');
  assert.equal(findTerm('remain as no more than "idiot savants" lacking', 'idiot savant').surface, 'idiot savants');
  assert.equal(findTerm('a perceived area extending', 'perceived area').surface, 'perceived area');
  assert.equal(findTerm('nothing here', 'amend'), null);
  assert.equal(findTerm('take care into account', 'take into account'), null);
});

test('masking hides the answer inside a meaning', () => {
  const m = mask('Rất, vô cùng; trong câu profoundly consistent = rất nhất quán.', 'profoundly');
  assert.ok(!/profoundly/i.test(m));
  assert.equal(gloss('Sửa đổi, điều chỉnh; trong câu: điều chỉnh kích thước vùng strike zone.'), 'Sửa đổi, điều chỉnh');
  assert.ok(gloss('Trong câu (nghĩa ẩn dụ): robot cực giỏi một số việc').startsWith('Robot'));
});

test('near-synonym meanings are detected as similar', () => {
  assert.ok(similarMeaning('Sửa đổi, điều chỉnh', 'Điều chỉnh nhẹ, tinh chỉnh'));
  assert.ok(similarMeaning('Xu hướng/khuynh hướng của con người', 'Xu hướng, khuynh hướng hoặc ý muốn làm gì'));
  assert.ok(!similarMeaning('Lành tính; không gây hại', 'Cuộc đối thoại, trao đổi'));
});

function d(n) { return addDays('2026-11-01', n); }
let seq = 0;
function rev(wordId, day, data) {
  seq++;
  return { eventId: 'e' + String(seq).padStart(5, '0'), type: 'review', wordId, ts: `${day}T0${seq % 10}:00:00.000Z`, studyDate: day, data: { outcome: 'correct', recallKind: 'unassisted_recall', ...data } };
}
const entries = [mkEntry('w1', 'amend', 'Sửa đổi')];

test('recall rule needs 3 separate dates incl. 1 contextual', () => {
  const evs = [rev('w1', d(0), {}), rev('w1', d(0), { contextual: true }), rev('w1', d(1), {})];
  let s = computeStates(entries, evs, DEFAULT_CONFIG, d(1)).states.get('w1');
  assert.equal(s.successDates.size, 2);
  assert.equal(s.recallMet, false);
  evs.push(rev('w1', d(3), {}));
  s = computeStates(entries, evs, DEFAULT_CONFIG, d(3)).states.get('w1');
  assert.equal(s.recallMet, true);
  assert.equal(s.eligibleForMastery, true, 'recall criteria alone make a word eligible for mastery');
});

test('recognition, hints, reveals, self-ratings and retries never satisfy recall', () => {
  const evs = [];
  for (let i = 0; i < 5; i++) {
    evs.push(rev('w1', d(i), { recallKind: 'recognition', contextual: true }));
    evs.push(rev('w1', d(i), { assisted: true, contextual: true }));
    evs.push(rev('w1', d(i), { recallKind: 'self_report', outcome: 'self_known' }));
    evs.push(rev('w1', d(i), { retry: true, contextual: true }));
  }
  const s = computeStates(entries, evs, DEFAULT_CONFIG, d(5)).states.get('w1');
  assert.equal(s.successDates.size, 0);
  assert.equal(s.recallMet, false);
});

test('contextual requirement and last-attempt requirement are enforced; config is respected', () => {
  const evs = [rev('w1', d(0), {}), rev('w1', d(1), {}), rev('w1', d(2), {})];
  assert.equal(computeStates(entries, evs, DEFAULT_CONFIG, d(2)).states.get('w1').recallMet, false);
  assert.equal(computeStates(entries, evs, { requiredContextual: 0 }, d(2)).states.get('w1').recallMet, true);
  evs.push(rev('w1', d(3), { contextual: true }), rev('w1', d(4), { outcome: 'wrong' }));
  assert.equal(computeStates(entries, evs, DEFAULT_CONFIG, d(4)).states.get('w1').recallMet, false);
  assert.equal(computeStates(entries, evs, { requiredDates: 5 }, d(4)).states.get('w1').recallMet, false);
});

test('schedule: only first graded attempt per day moves the box; wrong -> tomorrow', () => {
  const evs = [rev('w1', d(0), {}), rev('w1', d(0), {}), rev('w1', d(0), {})];
  let s = computeStates(entries, evs, DEFAULT_CONFIG, d(0)).states.get('w1');
  assert.equal(s.box, 1);
  assert.equal(s.nextReview, d(2));
  evs.push(rev('w1', d(2), { outcome: 'wrong' }));
  s = computeStates(entries, evs, DEFAULT_CONFIG, d(2)).states.get('w1');
  assert.equal(s.box, 0);
  assert.equal(s.nextReview, d(3));
});

test('mastery: recall criteria -> mastered event archives; restore resets recall; Sheet status mapping', () => {
  const evs = [rev('w1', d(0), { contextual: true }), rev('w1', d(1), {})];
  let s = computeStates(entries, evs, DEFAULT_CONFIG, d(1)).states.get('w1');
  assert.equal(s.eligibleForMastery, false);
  assert.equal(stateSnapshot(s, entries[0]).sheetStatus, 'Learning');
  evs.push(rev('w1', d(2), {}));
  s = computeStates(entries, evs, DEFAULT_CONFIG, d(2)).states.get('w1');
  assert.equal(s.eligibleForMastery, true);
  evs.push({ eventId: 'z1', type: 'mastered', wordId: 'w1', ts: `${d(3)}T13:00:00.000Z`, studyDate: d(3), data: {} });
  s = computeStates(entries, evs, DEFAULT_CONFIG, d(3)).states.get('w1');
  assert.equal(s.status, 'mastered');
  assert.equal(stateSnapshot(s, entries[0]).sheetStatus, 'Mastered');
  assert.equal(s.nextMaintenance, d(33));
  evs.push({ eventId: 'z2', type: 'restore', wordId: 'w1', ts: `${d(40)}T13:00:00.000Z`, studyDate: d(40), data: {} });
  s = computeStates(entries, evs, DEFAULT_CONFIG, d(40)).states.get('w1');
  assert.equal(s.archived, false);
  assert.equal(s.recallMet, false);
  assert.equal(s.due, true);
  assert.equal(stateSnapshot(s, entries[0]).sheetStatus, 'Review');
  // a word never studied is never written to the Sheet
  assert.equal(stateSnapshot(computeStates(entries, [], DEFAULT_CONFIG, d(0)).states.get('w1'), entries[0]).sheetStatus, '');
});

test('duplicate events (same eventId delivered twice) do not double count', () => {
  const e = rev('w1', d(0), {});
  const dedupe = (xs) => [...new Map(xs.map((x) => [x.eventId, x])).values()];
  const s = computeStates(entries, dedupe([e, { ...e }, { ...e }]), DEFAULT_CONFIG, d(0)).states.get('w1');
  assert.equal(s.attempts, 1);
});

function checkFairness(all) {
  let built = 0;
  for (const e of all) {
    for (const kind of ['mcq_meaning', 'context_meaning', 'paraphrase_term', 'confusable', 'gapfill_typed', 'recall_typed', 'paraphrase_typed']) {
      if (!available(kind, e, all)) continue;
      const item = buildItem(kind, e, all, 12345);
      if (!item) continue;
      built++;
      const promptText = JSON.stringify([item.cue, item.blanked, item.hintMeaning, item.options?.map((o) => o.text)]);
      if (kind !== 'paraphrase_term' && kind !== 'context_meaning' && kind !== 'mcq_meaning' && kind !== 'confusable') {
        assert.ok(!new RegExp(`\\b${e.fields.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(promptText), `${kind} for "${e.fields.term}" leaks the answer: ${promptText}`);
      }
      if (item.options) {
        assert.equal(item.options.filter((o) => o.correct).length, 1, `${kind}/${e.fields.term} must have one correct option`);
        const texts = item.options.map((o) => o.text.toLowerCase());
        assert.equal(new Set(texts).size, texts.length, `${kind}/${e.fields.term} has duplicate options`);
        const correct = all.find((x) => x.id === item.options.find((o) => o.correct).wordId);
        for (const o of item.options.filter((o) => !o.correct)) {
          const other = all.find((x) => x.id === o.wordId);
          if (kind === 'confusable' || (kind === 'context_meaning' && other.fields.term.toLowerCase() === correct.fields.term.toLowerCase())) continue;
          assert.ok(!similarMeaning(other.fields.meaning, correct.fields.meaning), `${kind}: "${other.fields.term}" too close to "${correct.fields.term}"`);
        }
      }
      if (item.accepted) assert.equal(gradeTyped(item.surface || e.fields.term, item, e, all).outcome, 'correct');
    }
  }
  return built;
}

test('demo data: every built exercise is fair (one defensible answer, no leaks)', () => {
  assert.ok(checkFairness(DEMO_ENTRIES) > 20);
});

test('real Sheet export (optional, VOCAB_CSV)', { skip: !process.env.VOCAB_CSV }, () => {
  const { entries: es } = entriesFromCSV(fs.readFileSync(process.env.VOCAB_CSV, 'utf8'));
  assert.ok(es.length > 0);
  const n = checkFairness(es);
  console.log(`  checked ${n} exercises over ${es.length} Sheet entries`);
});

test('typed grading: typo tolerance and near-synonym neutrality', () => {
  const all = [mkEntry('a', 'curb', 'Kiềm chế, hạn chế', { note: 'Gần nghĩa: restrict' }), mkEntry('b', 'restrict', 'Giới hạn trong phạm vi'), mkEntry('c', 'scrutinise', 'Xem xét kỹ lưỡng')];
  const item = buildItem('recall_typed', all[2], all, 1);
  assert.equal(gradeTyped('scrutinize', item, all[2], all).outcome, 'correct');
  assert.equal(gradeTyped('scrutinize', item, all[2], all).typo, true);
  assert.equal(gradeTyped('', item, all[2], all).outcome, 'revealed');
  const item2 = buildItem('recall_typed', all[0], all, 1);
  assert.equal(gradeTyped('restrict', item2, all[0], all).outcome, 'other_term');
  assert.equal(gradeTyped('banana', item2, all[0], all).outcome, 'wrong');
  assert.equal(normAnswer('  Take Into Account. '), 'take into account');
});

test('session: no archived words; wrong answers return later as retry', () => {
  const evs = [{ eventId: 'x', type: 'mastered', wordId: 'demo-01', ts: '2026-11-01T00:00:00Z', studyDate: '2026-11-01', data: {} }];
  const { states } = computeStates(DEMO_ENTRIES, evs, DEFAULT_CONFIG, '2026-11-02');
  const plan = planSession({ minutes: 2, mode: 'quick', entries: DEMO_ENTRIES, states, seed: 7 });
  assert.ok(plan.length >= 6);
  assert.ok(!plan.some((q) => q.wordId === 'demo-01'));
  const s = newSession({ minutes: 2, mode: 'quick', plan });
  const first = currentItem(s, DEMO_ENTRIES);
  recordAnswer(s, { outcome: 'wrong' });
  const again = s.queue.findIndex((q, i) => i > 0 && q.wordId === first.wordId && q.retry);
  assert.ok(again >= 1 && again <= 4, 'retry inserted a few items later');
});

test('CSV parser handles quotes, commas and newlines', () => {
  const rows = parseCSV('"a","b ""q""","c,d"\n"x\ny",2,3\n');
  assert.deepEqual(rows, [['a', 'b "q"', 'c,d'], ['x\ny', '2', '3']]);
});

test('quick play: after a first recognition answer, the word moves on to typed recall (no box-0 lock-in)', async () => {
  const e = DEMO_ENTRIES.find((x) => x.id === 'demo-01');
  const evs = [{ eventId: 'q1', type: 'review', wordId: e.id, ts: '2026-11-01T00:00:00Z', studyDate: '2026-11-01', data: { outcome: 'correct', recallKind: 'recognition', exercise: 'mcq_meaning' } }];
  const { states } = computeStates(DEMO_ENTRIES, evs, DEFAULT_CONFIG, '2026-11-02');
  assert.equal(states.get(e.id).box, 0);
  const plan = planSession({ minutes: 10, mode: 'quick', entries: DEMO_ENTRIES, states, seed: 3 });
  const first = plan.find((q) => q.wordId === e.id && !q.repeatInSession);
  assert.ok(['gapfill_typed', 'recall_typed'].includes(first.kind), `got ${first.kind}`);
  const kinds = new Set(plan.map((q) => q.kind));
  assert.ok(kinds.size >= 2, 'a session mixes exercise types');
});

test('maintenance: a mastered word is offered for maintenance only when due', () => {
  const mastered = (day) => [{ eventId: 'm1', type: 'mastered', wordId: 'demo-02', ts: `${day}T00:00:00Z`, studyDate: day, data: {} }];
  let { states } = computeStates(DEMO_ENTRIES, mastered('2026-11-01'), DEFAULT_CONFIG, '2026-11-20');
  assert.ok(!planSession({ minutes: 5, mode: 'quick', entries: DEMO_ENTRIES, states, seed: 1 }).some((q) => q.wordId === 'demo-02'));
  ({ states } = computeStates(DEMO_ENTRIES, mastered('2026-10-01'), DEFAULT_CONFIG, '2026-11-20'));
  const m = planSession({ minutes: 5, mode: 'quick', entries: DEMO_ENTRIES, states, seed: 1 }).filter((q) => q.wordId === 'demo-02');
  assert.equal(m.length, 1);
  assert.equal(m[0].maintenance, true);
});

test('backup: round-trip merge adds only what is missing and never deletes', async () => {
  const { makeBackup, validateBackup, planMerge } = await import('../app/js/core/backup.js');
  const events = [rev('w1', d(0), {}), rev('w1', d(1), {})].map((e) => ({ ...e, _synced: 1 }));
  const b = JSON.parse(JSON.stringify(makeBackup({ mode: 'live', deviceId: 'x', entries, events, settings: {} })));
  assert.deepEqual(validateBackup(b), []);
  assert.equal(planMerge(b, { events: [], entries: [], mode: 'live' }).newEvents.length, 2);
  const same = planMerge(b, { events, entries, mode: 'live' });
  assert.equal(same.newEvents.length, 0);
  assert.equal(same.newEntries.length, 0);
  assert.ok(validateBackup({ format: 'nope' }).length > 0);
});

// ---------------------------------------------------------------- Speaking results in progress
const spk = (wordId, day, data) => ({ eventId: 'sp-' + (++seq), type: 'speaking', wordId, ts: `${day}T09:00:00.000Z`, studyDate: day, deviceId: 'speaking-tab',
  data: { usage: 'pass', support: 'none', pronunciation: 'pass', evidence: 'audio', source: 'bot', ...data } });

test('speaking: own correct use = contextual unassisted recall date and box up; hint/model = no credit', () => {
  let s = computeStates(entries, [spk('w1', d(0), {})], DEFAULT_CONFIG, d(0)).states.get('w1');
  assert.deepEqual([...s.successDates], [d(0)]);
  assert.deepEqual([...s.contextualDates], [d(0)]);
  assert.equal(s.box, 1);
  assert.equal(s.nextReview, d(2));
  assert.equal(s.speakPron.value, 'pass');
  for (const support of ['hint', 'model', 'unknown']) {
    s = computeStates(entries, [spk('w1', d(0), { support })], DEFAULT_CONFIG, d(0)).states.get('w1');
    assert.equal(s.successDates.size, 0, support);
    assert.equal(s.box, 0, support);
    assert.equal(s.nextReview, d(1), `${support}: hold`);
    assert.equal(s.status, 'learning');
  }
});

test('speaking: wrong use schedules sooner; pronunciation needs audio; pronunciation-only has no recall effect', () => {
  const evs = [rev('w1', d(0), { contextual: true }), spk('w1', d(2), { usage: 'needs_work' })];
  let s = computeStates(entries, evs, DEFAULT_CONFIG, d(2)).states.get('w1');
  assert.equal(s.box, 0);
  assert.equal(s.nextReview, d(3));
  assert.equal(s.lastUnassisted, 'wrong');
  s = computeStates(entries, [spk('w1', d(0), { evidence: 'transcript' })], DEFAULT_CONFIG, d(0)).states.get('w1');
  assert.equal(s.speakPron, undefined, 'transcript never confirms pronunciation');
  s = computeStates(entries, [spk('w1', d(0), { usage: 'not_assessed' })], DEFAULT_CONFIG, d(0)).states.get('w1');
  assert.equal(s.speakPron.value, 'pass');
  assert.equal(s.attempts, 0);
  assert.equal(s.successDates.size, 0);
  assert.equal(s.status, 'new');
});

test('speaking: counts toward mastery together with app reviews; one box move per day; duplicates harmless', () => {
  const sp = spk('w1', d(2), {});
  const evs = [rev('w1', d(0), {}), rev('w1', d(1), {}), rev('w1', d(2), {}), sp, { ...sp }];
  const dedupe = (xs) => [...new Map(xs.map((x) => [x.eventId, x])).values()];
  const s = computeStates(entries, dedupe(evs), DEFAULT_CONFIG, d(2)).states.get('w1');
  assert.equal(s.successDates.size, 3);
  assert.equal(s.contextualDates.size, 1, 'the speaking result supplies the contextual date');
  assert.equal(s.eligibleForMastery, true);
  assert.equal(s.box, 3, 'review + speaking on the same day move the box once');
  assert.equal(s.attempts, 4);
});

test('speaking: mastered words stay mastered; results only move maintenance', () => {
  const m = { eventId: 'mm', type: 'mastered', wordId: 'w1', ts: `${d(0)}T10:00:00.000Z`, studyDate: d(0), data: {} };
  let s = computeStates(entries, [m, spk('w1', d(10), {})], DEFAULT_CONFIG, d(10)).states.get('w1');
  assert.equal(s.status, 'mastered');
  assert.equal(s.nextMaintenance, d(100), 'good result counts as the 1st maintenance (next after 90 days)');
  s = computeStates(entries, [m, spk('w1', d(10), { usage: 'needs_work' })], DEFAULT_CONFIG, d(10)).states.get('w1');
  assert.equal(s.status, 'mastered');
  assert.equal(s.archived, true);
  assert.equal(s.maintenanceDue, true, 'weak result brings the maintenance check forward');
  const plan = planSession({ minutes: 5, mode: 'quick', entries: [...entries, ...DEMO_ENTRIES], states: computeStates([...entries, ...DEMO_ENTRIES], [m, spk('w1', d(10), { usage: 'needs_work' })], DEFAULT_CONFIG, d(10)).states, seed: 1 });
  assert.ok(plan.some((q) => q.wordId === 'w1' && q.maintenance));
});
