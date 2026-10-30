// Text helpers: normalisation, inflection-tolerant term matching, masking, glosses
// and meaning similarity (used to keep multiple-choice options unambiguous).

export function norm(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normAnswer(s) {
  return norm(s)
    .replace(/^[\s"'.,!?;:()[\]]+|[\s"'.,!?;:()[\]]+$/g, '')
    .replace(/\s*-\s*/g, '-');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)*['’]?/g;

function tokens(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(WORD_RE)) {
    out.push({ raw: m[0], start: m.index, end: m.index + m[0].length, n: norm(m[0]).replace(/'s?$/, '') });
  }
  return out;
}

// Does sentence token `t` look like an inflection of term token `base`?
export function inflects(t, base) {
  if (!t || !base) return false;
  if (t === base) return true;
  for (const s of ['s', 'es', 'ed', 'd', 'ing', 'ly', 'er', 'ers']) if (t === base + s) return true;
  if (base.endsWith('s') && t === base.slice(0, -1)) return true; // plural term, singular in text
  if (base.endsWith('e') && (t === base.slice(0, -1) + 'ing')) return true;
  if (base.endsWith('y') && ['ied', 'ies', 'ier'].some((s) => t === base.slice(0, -1) + s)) return true;
  const last = base.at(-1);
  if (/[bcdfgklmnprstvz]/.test(last) && ['ed', 'ing', 'er'].some((s) => t === base + last + s)) return true;
  return false;
}

function termTokens(term) {
  return tokens(term).map((t) => t.n);
}

// All matches of `term` (allowing inflection of any word) inside `text`.
export function findAll(text, term) {
  const tt = termTokens(term);
  if (!tt.length) return [];
  const st = tokens(text);
  const out = [];
  for (let i = 0; i + tt.length <= st.length; i++) {
    let ok = true;
    for (let k = 0; k < tt.length; k++) {
      if (!inflects(st[i + k].n, tt[k])) { ok = false; break; }
      // words of a phrase must be adjacent (only spaces between them)
      if (k > 0 && !/^\s+$/.test(text.slice(st[i + k - 1].end, st[i + k].start))) { ok = false; break; }
    }
    if (ok) {
      const start = st[i].start, end = st[i + tt.length - 1].end;
      out.push({ start, end, surface: text.slice(start, end) });
      i += tt.length - 1;
    }
  }
  return out;
}

export function findTerm(text, term) {
  return findAll(text, term)[0] || null;
}

// Replace occurrences of the term (and, for phrases, its longer words) so a prompt
// never shows the answer.
export function mask(text, term, glyph = '▢▢▢') {
  let s = String(text ?? '');
  const apply = (t) => {
    const ms = findAll(s, t);
    for (let i = ms.length - 1; i >= 0; i--) s = s.slice(0, ms[i].start) + glyph + s.slice(ms[i].end);
  };
  apply(term);
  const parts = termTokens(term);
  if (parts.length > 1) parts.filter((p) => p.length >= 4).forEach(apply);
  return s;
}

// Remove a trailing Vietnamese translation in parentheses from "Ví dụ bổ sung".
export function stripTranslation(s) {
  return String(s ?? '').replace(/\s*\([^()]*[À-ỹ][^()]*\)\s*$/u, '').trim();
}

// Short, general part of a meaning ("Sửa đổi, điều chỉnh; trong câu: ..." -> "Sửa đổi, điều chỉnh").
export function gloss(meaning, max = 110) {
  let m = String(meaning ?? '').trim();
  const cut = m.search(/[;.]\s*(trong câu|trong bài)/i);
  let g = cut > 0 ? m.slice(0, cut) : m;
  if (/^(trong câu|trong bài)/i.test(g)) g = g.replace(/^(trong câu|trong bài)[^:]*:\s*/i, '');
  g = g.replace(/[\s;.,:]+$/, '');
  if (g.length > max) {
    g = g.slice(0, max);
    g = g.slice(0, Math.max(g.lastIndexOf(' '), max * 0.6)) + '…';
  }
  return g ? g.charAt(0).toUpperCase() + g.slice(1) : '';
}

const VI_STOP = new Set(('của và là một những các có được cho trong câu bài người việc sự không nhất thiết hoặc với để này đó ' +
  'theo như khi thì mà ở từ đã đang sẽ rằng nào rất vô cùng cũng thể tùy ngữ cảnh nghĩa ai gì làm hay ra vào lên ' +
  'nhau giữa hai nhiều cái con vật trên dưới về bằng nên chỉ còn đến tới a b').split(' '));

function syllables(s) {
  return norm(s).split(/[^\p{L}]+/u).filter((w) => w.length > 1 && !VI_STOP.has(w));
}

// Meanings are "too similar" for distractors if they share a two-syllable word
// (Vietnamese compounds such as "điều chỉnh", "xu hướng") or overlap heavily.
export function similarMeaning(a, b) {
  const A = syllables(gloss(a, 400)), B = syllables(gloss(b, 400));
  if (!A.length || !B.length) return false;
  const bigrams = (xs) => new Set(xs.slice(1).map((x, i) => xs[i] + ' ' + x));
  const ba = bigrams(A), bb = bigrams(B);
  for (const g of ba) if (bb.has(g)) return true;
  const sa = new Set(A), sb = new Set(B);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.34;
}

// Entries linked by their notes ("Gần nghĩa: modify", "phân biệt với surpass", ...)
// are treated as easily confused and never used as each other's distractors.
export function mentions(entry, otherTerm) {
  const f = entry.fields;
  const blob = [f.note, f.usage, f.meaning].join(' \n ');
  return findAll(blob, otherTerm).length > 0;
}
