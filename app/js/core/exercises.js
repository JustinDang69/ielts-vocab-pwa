// Exercise generation and grading. Rules that keep questions fair:
//  - prompts never contain the answer (terms are masked in meanings),
//  - distractors never share a meaning with the answer (similarMeaning), never come from
//    an entry with the same term, and never from entries whose notes link them
//    (near-synonyms such as amend/tweak) — so exactly one option is defensible,
//  - if not enough safe distractors exist, the exercise type is simply not offered.
import { norm, normAnswer, levenshtein, findTerm, mask, gloss, similarMeaning, mentions, stripTranslation } from './text.js';

export const KIND_LABEL = {
  card: 'Thẻ',
  mcq_meaning: 'Chọn nghĩa',
  gapfill_typed: 'Điền vào câu',
  recall_typed: 'Nhớ lại từ',
  context_meaning: 'Nghĩa trong ngữ cảnh',
  paraphrase_term: 'Paraphrase → từ',
  paraphrase_typed: 'Paraphrase → gõ từ',
  confusable: 'Phân biệt nghĩa dễ nhầm',
};

// Which exercises count as unassisted recall (typed, no options) vs recognition.
const RECALL_KIND = {
  card: 'self_report',
  mcq_meaning: 'recognition',
  context_meaning: 'recognition',
  paraphrase_term: 'recognition',
  confusable: 'recognition',
  gapfill_typed: 'unassisted_recall',
  recall_typed: 'unassisted_recall',
  paraphrase_typed: 'unassisted_recall',
};
const CONTEXTUAL = new Set(['gapfill_typed', 'paraphrase_typed', 'context_meaning', 'paraphrase_term']);

export function rngFrom(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Sentence for contextual exercises: the original context ("Câu gốc") when the term can be
// located in it; otherwise the Sheet's extra example, clearly labelled as NOT original.
export function contextFor(entry) {
  const f = entry.fields;
  if (f.context) {
    const m = findTerm(f.context, f.term);
    if (m) return { text: f.context, match: m, origin: 'original' };
  }
  const ex = stripTranslation(f.example);
  if (ex) {
    const m = findTerm(ex, f.term);
    if (m) return { text: ex, match: m, origin: 'example' };
  }
  return null;
}

export function blankOut(ctx) {
  const words = ctx.match.surface.split(/\s+/).length;
  const blank = Array(words).fill('_____').join(' ');
  return { before: ctx.text.slice(0, ctx.match.start), blank, after: ctx.text.slice(ctx.match.end) };
}

function conflicts(a, b) {
  if (a.id === b.id) return true;
  if (norm(a.fields.term) === norm(b.fields.term)) return true;
  if (!b.fields.meaning || !a.fields.meaning) return true;
  if (norm(gloss(a.fields.meaning)) === norm(gloss(b.fields.meaning))) return true;
  if (similarMeaning(a.fields.meaning, b.fields.meaning)) return true;
  if (mentions(a, b.fields.term) || mentions(b, a.fields.term)) return true;
  return false;
}

export function safeDistractors(target, pool, n, rnd) {
  const picked = [];
  for (const c of shuffle(pool, rnd)) {
    if (picked.length >= n) break;
    if (c.inSheet === false || conflicts(target, c)) continue;
    if (picked.some((p) => conflicts(p, c))) continue; // distractors must also be distinct
    picked.push(c);
  }
  return picked.length >= Math.min(n, 2) ? picked : null;
}

// Easily confused pairs: entries whose notes reference each other or whose meanings
// overlap (e.g. amend / tweak). Same term with different senses is handled by
// context_meaning instead, because only the sentence can tell those apart.
export function confusablePartner(target, pool, rnd) {
  const cands = pool.filter((c) => c.id !== target.id && c.inSheet !== false && c.fields.meaning
    && norm(c.fields.term) !== norm(target.fields.term)
    && norm(gloss(c.fields.meaning)) !== norm(gloss(target.fields.meaning))
    && (mentions(target, c.fields.term) || mentions(c, target.fields.term)
      || similarMeaning(c.fields.meaning, target.fields.meaning)));
  return cands.length ? shuffle(cands, rnd)[0] : null;
}

export function available(kind, entry, pool) {
  const f = entry.fields;
  if (!f.term || !f.meaning) return kind === 'card' && !!f.term;
  const ctx = contextFor(entry);
  switch (kind) {
    case 'card': case 'recall_typed': return true;
    case 'mcq_meaning': return pool.filter((c) => !conflicts(entry, c)).length >= 2;
    case 'gapfill_typed': case 'paraphrase_typed': return !!ctx;
    case 'context_meaning': return !!(f.context && findTerm(f.context, f.term)) && pool.filter((c) => !conflicts(entry, c)).length >= 2;
    case 'paraphrase_term': return !!ctx && pool.filter((c) => !conflicts(entry, c)).length >= 2;
    case 'confusable': return true; // decided at build time (needs a partner)
    default: return false;
  }
}

function optionMeaning(e) {
  return mask(gloss(e.fields.meaning), e.fields.term);
}

export function acceptedAnswers(entry, ctx) {
  const set = new Set([normAnswer(entry.fields.term)]);
  if (ctx) set.add(normAnswer(ctx.match.surface));
  return [...set];
}

// Build a concrete, serialisable exercise item. Returns null if it can't be built fairly.
export function buildItem(kind, entry, pool, seed) {
  const rnd = rngFrom(seed);
  const f = entry.fields;
  const base = {
    kind, wordId: entry.id, seed,
    recallKind: RECALL_KIND[kind], contextual: CONTEXTUAL.has(kind),
    term: f.term,
  };
  const ctx = contextFor(entry);
  if (kind === 'card') return { ...base, hint: f.context ? { text: f.context, origin: 'original' } : null };

  if (kind === 'mcq_meaning' || kind === 'context_meaning') {
    let partners = [];
    if (kind === 'context_meaning') {
      // other senses of the same term make the best "easily confused" options
      partners = pool.filter((c) => c.id !== entry.id && norm(c.fields.term) === norm(f.term) && c.fields.meaning
        && norm(gloss(c.fields.meaning)) !== norm(gloss(f.meaning)));
      partners = partners.slice(0, 1);
    }
    const ds = safeDistractors(entry, pool.filter((c) => !partners.includes(c)), 3 - partners.length, rnd);
    if (!ds) return null;
    const opts = shuffle([{ text: optionMeaning(entry), wordId: entry.id, correct: true },
      ...[...partners, ...ds].map((d) => ({ text: optionMeaning(d), wordId: d.id, correct: false }))], rnd);
    const item = { ...base, options: opts };
    if (kind === 'context_meaning') {
      const m = findTerm(f.context, f.term);
      if (!m) return null;
      item.sentence = { text: f.context, start: m.start, end: m.end, origin: 'original' };
    }
    return item;
  }

  if (kind === 'paraphrase_term') {
    if (!ctx) return null;
    const ds = safeDistractors(entry, pool, 3, rnd);
    if (!ds) return null;
    return {
      ...base,
      cue: optionMeaning(entry),
      blanked: blankOut(ctx), origin: ctx.origin,
      options: shuffle([{ text: f.term, wordId: entry.id, correct: true },
        ...ds.map((d) => ({ text: d.fields.term, wordId: d.id, correct: false }))], rnd),
    };
  }

  if (kind === 'confusable') {
    const p = confusablePartner(entry, pool, rnd);
    if (!p) return null;
    const m2 = (e) => mask(mask(gloss(e.fields.meaning), f.term), p.fields.term);
    return {
      ...base, partnerId: p.id, partnerTerm: p.fields.term,
      options: shuffle([{ text: m2(entry), wordId: entry.id, correct: true },
        { text: m2(p), wordId: p.id, correct: false }], rnd),
    };
  }

  if (kind === 'gapfill_typed' || kind === 'paraphrase_typed') {
    if (!ctx) return null;
    return {
      ...base,
      blanked: blankOut(ctx), origin: ctx.origin,
      cue: kind === 'paraphrase_typed' ? optionMeaning(entry) : null,
      hintMeaning: kind === 'gapfill_typed' ? optionMeaning(entry) : null,
      accepted: acceptedAnswers(entry, ctx),
      firstLetters: ctx.match.surface.split(/\s+/).map((w) => w[0] + '…').join(' '),
      surface: ctx.match.surface,
    };
  }

  if (kind === 'recall_typed') {
    return {
      ...base,
      cue: mask(f.meaning, f.term),
      typeLabel: f.type || '',
      topic: f.topic || '',
      accepted: acceptedAnswers(entry, null),
      firstLetters: f.term.split(/\s+/).map((w) => w[0] + '…').join(' '),
    };
  }
  return null;
}

// Grade a typed answer. Small typos on longer words are accepted (and pointed out).
// Typing another list word that is a near-synonym of the answer is neutral ("other_term").
export function gradeTyped(input, item, entry, pool) {
  const a = normAnswer(input);
  if (!a) return { outcome: 'revealed' };
  if (item.accepted.includes(a)) return { outcome: 'correct' };
  for (const acc of item.accepted) {
    if (acc.length >= 6 && levenshtein(a, acc) <= 1) return { outcome: 'correct', typo: true, expected: acc };
  }
  const other = pool.find((c) => c.id !== entry.id && normAnswer(c.fields.term) === a);
  if (other && (similarMeaning(other.fields.meaning, entry.fields.meaning) || mentions(entry, other.fields.term) || mentions(other, entry.fields.term))) {
    return { outcome: 'other_term', otherId: other.id };
  }
  return { outcome: 'wrong' };
}

export function itemKey(item) {
  return `${item.kind}:${item.wordId}`;
}
