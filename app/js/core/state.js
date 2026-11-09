// Event replay: every word's learning state is derived from the append-only event log.
// Same events in -> same state out, on every device. That is what makes offline use,
// retries and duplicate deliveries safe: there is nothing to "overwrite".
import { addDays, daysBetween } from './dates.js';

export const DEFAULT_CONFIG = {
  // Recall rule: unassisted recall succeeded on N separate study dates, at least
  // M of them in a contextual exercise, and the most recent unassisted attempt succeeded.
  requiredDates: 3,
  requiredContextual: 1,
  // Leitner boxes: box b -> next review b's interval (days) after the study date.
  intervals: [1, 2, 4, 7, 15, 30, 60, 120],
  maintenanceIntervals: [30, 90, 180],
  itemsPerSession: { 2: 6, 5: 14, 10: 28 },
  newPerSession: { 2: 2, 5: 4, 10: 6 },
  timezone: 'Australia/Sydney',
};

export const EVENT_TYPES = ['review', 'speaking', 'mastered', 'restore', 'flag_item'];

// Outcomes of a review event.
//  correct      – answered correctly
//  wrong        – answered incorrectly
//  revealed     – asked to see the answer without answering
//  other_term   – typed a different (near-synonym) word from the list: neutral
//  self_known / self_unsure / self_unknown – Chill Cards self-rating after reveal
const NEGATIVE = new Set(['wrong', 'revealed', 'self_unknown']);

export const STATUS_LABEL = {
  new: 'Mới',
  learning: 'Đang học',
  review: 'Cần ôn',
  mastered: 'Đã thuộc',
  removed: 'Không còn trong Sheet',
};

// What the app writes into the Sheet's "Trạng thái" column (Max reads it there).
// "new" is never written: the app has no information about a word it hasn't studied.
export const SHEET_STATUS_FOR = {
  learning: 'Learning', review: 'Review', mastered: 'Mastered',
};

export function sortEvents(events) {
  return [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}

function blank(id) {
  return {
    id,
    box: 0,
    nextReview: null,
    lastStudyDate: null,
    firstSeen: null,
    gradedDays: {},          // studyDate -> 'up' | 'hold' | 'down' (first graded attempt only)
    successDates: new Set(), // unassisted recall successes (non-retry)
    contextualDates: new Set(),
    lastUnassisted: null,
    attempts: 0,
    errors: 0,
    hintsUsed: 0,
    archived: false,
    masteredAt: null,
    lastMaintenance: null,
    maintenanceCount: 0,
    restoredAt: null,
    history: [],
  };
}

export function computeStates(entries, events, config = DEFAULT_CONFIG, today) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const states = new Map();
  const flags = new Set();
  const get = (id) => {
    if (!states.has(id)) states.set(id, blank(id));
    return states.get(id);
  };
  for (const e of entries) get(e.id);
  // Schedule: only the first graded attempt (app review or Speaking result) of a study date moves the box.
  const grade = (s, day, r) => {
    if (s.gradedDays[day]) return;
    s.gradedDays[day] = r;
    if (r === 'up') s.box = Math.min(s.box + 1, cfg.intervals.length - 1);
    if (r === 'down') s.box = Math.max(0, s.box - 1);
    s.nextReview = addDays(day, r === 'down' ? 1 : cfg.intervals[s.box]);
  };

  // "This question was unfair" voids the review it was raised on.
  const voided = new Set(events.filter((e) => e.type === 'flag_item' && e.data?.voidEventId).map((e) => e.data.voidEventId));
  for (const ev of sortEvents(events)) {
    if (ev.type === 'flag_item') { if (ev.data?.itemKey) flags.add(ev.data.itemKey); continue; }
    if (voided.has(ev.eventId)) continue;
    if (!ev.wordId || ev.wordId === '*') continue;
    const s = get(ev.wordId);
    const d = ev.data || {};
    if (ev.type === 'review') {
      s.history.push(ev);
      s.attempts++;
      if (d.outcome === 'wrong') s.errors++;
      if (d.assisted) s.hintsUsed++;
      if (!s.firstSeen) s.firstSeen = ev.studyDate;
      if (s.archived) {
        if (d.maintenance) { s.lastMaintenance = ev.studyDate; s.maintenanceCount++; s.maintenanceForce = false; }
        continue;
      }
      s.lastStudyDate = ev.studyDate;
      const graded = !d.retry && !d.repeatInSession;
      const unassistedRecall = d.recallKind === 'unassisted_recall' && !d.assisted;
      // Recall progress
      if (!d.retry && unassistedRecall && d.outcome !== 'other_term') {
        s.lastUnassisted = d.outcome;
        if (d.outcome === 'correct') {
          s.successDates.add(ev.studyDate);
          if (d.contextual) s.contextualDates.add(ev.studyDate);
        }
      }
      if (graded && d.outcome !== 'other_term') {
        grade(s, ev.studyDate, NEGATIVE.has(d.outcome) ? 'down' : d.outcome === 'correct' && unassistedRecall ? 'up' : 'hold');
      } else if (!s.nextReview) {
        s.nextReview = addDays(ev.studyDate, 1);
      }
    } else if (ev.type === 'speaking') {
      // A result written by the Speaking chatbot into the "Speaking Results" tab.
      s.history.push(ev);
      const rec = { at: ev.studyDate, ts: ev.ts, source: d.source, feedback: d.feedback, sentence: d.sentence, support: d.support, evidence: d.evidence };
      // pronunciation only counts as assessed when the bot heard audio (the server enforces this too)
      if ((d.pronunciation === 'pass' || d.pronunciation === 'needs_work') && d.evidence === 'audio') s.speakPron = { ...rec, value: d.pronunciation };
      if (d.usage !== 'pass' && d.usage !== 'needs_work') continue; // no usage verdict: history only
      s.speakUsage = { ...rec, value: d.usage };
      const own = d.support === 'none'; // said unprompted: no hint, not repeating a model sentence
      s.attempts++;
      if (d.usage === 'needs_work') s.errors++;
      if (!own) s.hintsUsed++;
      if (!s.firstSeen) s.firstSeen = ev.studyDate;
      if (s.archived) {
        // Mastered words stay mastered: a good result counts as maintenance, a weak one brings it forward.
        if (d.usage === 'pass' && own) { s.lastMaintenance = ev.studyDate; s.maintenanceCount++; s.maintenanceForce = false; }
        else if (d.usage === 'needs_work') s.maintenanceForce = true;
        continue;
      }
      s.lastStudyDate = ev.studyDate;
      // Using the word correctly in your own sentence, unprompted = contextual unassisted recall.
      if (own) {
        s.lastUnassisted = d.usage === 'pass' ? 'correct' : 'wrong';
        if (d.usage === 'pass') { s.successDates.add(ev.studyDate); s.contextualDates.add(ev.studyDate); }
      }
      grade(s, ev.studyDate, d.usage === 'needs_work' ? 'down' : own ? 'up' : 'hold');
    } else if (ev.type === 'mastered') {
      if (!s.archived) { s.archived = true; s.masteredAt = ev.studyDate; s.history.push(ev); }
    } else if (ev.type === 'restore') {
      s.history.push(ev);
      s.archived = false;
      s.restoredAt = ev.studyDate;
      s.successDates = new Set();
      s.contextualDates = new Set();
      s.lastUnassisted = null;
      s.box = 0;
      s.nextReview = ev.studyDate;
    }
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const s of states.values()) {
    const entry = byId.get(s.id);
    s.inSheet = !!entry && entry.inSheet !== false;
    s.recallMet = s.successDates.size >= cfg.requiredDates
      && s.contextualDates.size >= cfg.requiredContextual
      && s.lastUnassisted === 'correct';
    s.eligibleForMastery = s.recallMet && !s.archived;
    if (s.archived) {
      const base = s.lastMaintenance || s.masteredAt;
      const iv = cfg.maintenanceIntervals[Math.min(s.maintenanceCount, cfg.maintenanceIntervals.length - 1)];
      s.nextMaintenance = base ? addDays(base, iv) : null;
      s.maintenanceDue = (!!s.nextMaintenance && !!today && s.nextMaintenance <= today) || !!s.maintenanceForce;
    }
    if (!s.inSheet) s.status = 'removed';
    else if (s.archived) s.status = 'mastered';
    else if (!s.attempts) s.status = 'new';
    else if (today && s.nextReview && s.nextReview <= today) s.status = 'review';
    else s.status = 'learning';
    s.due = s.status === 'new' || (today && s.nextReview && s.nextReview <= today && !s.archived);
    s.overdueDays = today && s.nextReview ? daysBetween(s.nextReview, today) : 0;
  }
  return { states, flags };
}

// Human-readable explanation of where a word stands (shown in the word detail screen).
export function explainRecall(s, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const parts = [
    `Nhớ không gợi ý: ${Math.min(s.successDates.size, cfg.requiredDates)}/${cfg.requiredDates} ngày khác nhau`,
    `Trong ngữ cảnh: ${Math.min(s.contextualDates.size, cfg.requiredContextual)}/${cfg.requiredContextual}`,
  ];
  if (s.successDates.size >= cfg.requiredDates && s.lastUnassisted !== 'correct') {
    parts.push('Lần gần nhất chưa nhớ được — cần một lần nhớ đúng nữa');
  }
  return parts;
}

// Snapshot written to the server's readable "WordState" mirror.
export function stateSnapshot(s, entry) {
  return {
    wordId: s.id,
    term: entry?.fields?.term || '',
    status: s.status,
    sheetStatus: SHEET_STATUS_FOR[s.status] || '',
    box: s.box,
    nextReview: s.nextReview || '',
    lastStudyDate: s.lastStudyDate || '',
    successDates: [...s.successDates].sort().join(' '),
    contextualDates: [...s.contextualDates].sort().join(' '),
    recallMet: s.recallMet,
    maxPronunciation: s.speakPron?.value || '', // legacy column names, now the latest Speaking results
    maxUsage: s.speakUsage?.value || '',
    archived: s.archived,
    attempts: s.attempts,
    errors: s.errors,
    hintsUsed: s.hintsUsed,
  };
}
