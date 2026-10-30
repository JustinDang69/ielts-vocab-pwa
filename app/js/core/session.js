// Session planning: which words, which exercise for each, and where wrong answers return.
import { DEFAULT_CONFIG } from './state.js';
import { available, buildItem, rngFrom, itemKey } from './exercises.js';

// First exposure (or just got it wrong): recognition. Otherwise: recall/context practice.
// `salt` (position in the session) rotates the order so a session mixes exercise types.
const ORDERS = {
  quick: { intro: ['mcq_meaning'], practice: ['gapfill_typed', 'recall_typed', 'mcq_meaning'] },
  detective: { intro: ['context_meaning', 'paraphrase_term', 'confusable'], practice: ['paraphrase_typed', 'confusable', 'context_meaning', 'paraphrase_term'] },
};
const rotate = (xs, n) => xs.map((_, i) => xs[(i + n) % xs.length]);

function chooseKind(mode, entry, state, pool, flags, salt) {
  if (mode === 'chill') return 'card';
  const last = state?.history?.filter((e) => e.type === 'review').at(-1)?.data?.outcome;
  const intro = !state?.attempts || ['wrong', 'revealed', 'self_unknown'].includes(last);
  const o = ORDERS[mode] || ORDERS.quick;
  const order = [...rotate(intro ? o.intro : o.practice, salt), ...(intro ? o.practice : o.intro), 'mcq_meaning', 'recall_typed', 'card'];
  for (const k of order) {
    if (flags.has(`${k}:${entry.id}`)) continue;
    if (available(k, entry, pool) && buildItem(k, entry, pool, 1)) return k;
  }
  return 'card';
}

// Pick words for a session: due reviews first (most overdue first), then a few new
// words (oldest first), then not-yet-due learning words, then one maintenance word for
// archived/mastered items whose maintenance date has come.
export function planSession({ minutes, mode, entries, states, flags = new Set(), config = DEFAULT_CONFIG, seed = Date.now() }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const target = cfg.itemsPerSession[minutes] || 14;
  const newCap = cfg.newPerSession[minutes] || 4;
  const active = entries.filter((e) => {
    const s = states.get(e.id);
    return e.inSheet !== false && e.fields.term && s && !s.archived;
  });
  const st = (e) => states.get(e.id);
  const due = active.filter((e) => st(e).status !== 'new' && st(e).due).sort((a, b) => st(b).overdueDays - st(a).overdueDays);
  const fresh = active.filter((e) => st(e).status === 'new').sort((a, b) => (a.fields.dateAdded || '').localeCompare(b.fields.dateAdded || '') || (a.row || 0) - (b.row || 0));
  const later = active.filter((e) => st(e).status !== 'new' && !st(e).due).sort((a, b) => (st(a).nextReview || '').localeCompare(st(b).nextReview || ''));
  const picked = [];
  for (const e of due) if (picked.length < target) picked.push(e);
  for (const e of fresh.slice(0, newCap)) if (picked.length < target) picked.push(e);
  for (const e of later) if (picked.length < target) picked.push(e);
  // Short of words? Fill with remaining new words.
  for (const e of fresh.slice(newCap)) if (picked.length < target) picked.push(e);

  const queue = picked.map((e, i) => ({ wordId: e.id, kind: chooseKind(mode, e, st(e), entries, flags, i) }));
  if (minutes >= 5) {
    const m = entries.find((e) => states.get(e.id)?.archived && states.get(e.id)?.maintenanceDue && e.inSheet !== false);
    if (m) queue.splice(Math.min(2, queue.length), 0, { wordId: m.id, kind: mode === 'chill' ? 'card' : (available('recall_typed', m, entries) ? 'recall_typed' : 'card'), maintenance: true });
  }
  // Few words available: a second round with different exercises (no extra credit).
  if (queue.length && queue.length < target) {
    const extra = [];
    for (let r = 1; queue.length + extra.length < target && r <= 2; r++) {
      for (const e of picked) {
        if (queue.length + extra.length >= target) break;
        const first = queue.find((q) => q.wordId === e.id)?.kind;
        let kind = chooseKind(mode, e, { ...st(e), attempts: 1, history: [] }, entries, flags, queue.length + extra.length + r);
        if (kind === first) kind = chooseKind(mode, e, { ...st(e), attempts: 1, history: [] }, entries, flags, queue.length + extra.length + r + 1);
        extra.push({ wordId: e.id, kind, repeatInSession: true });
      }
    }
    queue.push(...extra);
  }
  const rnd = rngFrom(seed);
  return queue.map((q, i) => ({ ...q, seed: Math.floor(rnd() * 2 ** 31) + i }));
}

export function newSession({ minutes, mode, plan }) {
  return {
    id: 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    minutes, mode, startedAt: new Date().toISOString(),
    queue: plan, index: 0, done: [], requeued: {}, finished: false,
  };
}

// Materialise the current item (stored on the queue entry so resume shows the same item).
export function currentItem(session, entries) {
  const q = session.queue[session.index];
  if (!q) return null;
  if (q.item) return q.item;
  const entry = entries.find((e) => e.id === q.wordId);
  if (!entry) return null;
  let item = buildItem(q.kind, entry, entries, q.seed);
  if (!item) item = buildItem('recall_typed', entry, entries, q.seed) || buildItem('card', entry, entries, q.seed);
  q.item = item;
  return item;
}

const MAX_RETRIES = 2;

// Record an answer in the session. Wrong / unknown answers come back 3 items later
// (or at the end) as a retry, which never counts towards long-term recall.
export function recordAnswer(session, result) {
  const q = session.queue[session.index];
  session.done.push({ wordId: q.wordId, kind: q.item?.kind || q.kind, recallKind: q.item?.recallKind, outcome: result.outcome, assisted: !!result.assisted, retry: !!q.retry, maintenance: !!q.maintenance });
  const needsAgain = ['wrong', 'revealed', 'self_unknown'].includes(result.outcome) && !q.maintenance;
  if (needsAgain) {
    const n = session.requeued[q.wordId] || 0;
    if (n < MAX_RETRIES) {
      session.requeued[q.wordId] = n + 1;
      const kind = q.item?.kind === 'card' ? 'card' : (q.item?.kind || q.kind);
      const at = Math.min(session.index + 4, session.queue.length);
      session.queue.splice(at, 0, { wordId: q.wordId, kind, retry: true, seed: (q.seed || 1) + 7919 * (n + 1) });
    }
  }
  session.index++;
  if (session.index >= session.queue.length) session.finished = true;
  return session;
}

export function reviewEventData(session, item, result) {
  const q = session.queue[session.index];
  return {
    mode: session.mode,
    exercise: item.kind,
    outcome: result.outcome,
    recallKind: item.recallKind,
    contextual: !!item.contextual,
    assisted: !!result.assisted,
    hints: result.hints || 0,
    retry: !!q.retry,
    repeatInSession: !!q.repeatInSession,
    maintenance: !!q.maintenance,
    typo: !!result.typo,
    answer: result.answer ? String(result.answer).slice(0, 80) : undefined,
    sessionId: session.id,
    itemKey: itemKey(item),
  };
}
