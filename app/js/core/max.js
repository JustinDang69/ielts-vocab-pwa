// Max handoff. The app cannot see the ChatGPT conversation, audio or Max's results.
// Export: a prompt with stable IDs and target usage that Justin pastes into Max.
// Import: Justin pastes Max's JSON back; it is validated and previewed before applying.
// Rules enforced here:
//  - pronunciation "pass" is only accepted when Max reports it actually heard audio
//    (pronunciationEvidence "audio"); otherwise it becomes "not_assessed",
//  - missing values stay "not_assessed"; nothing is ever filled in by the app.
import { isYmd } from './dates.js';
import { gloss, norm } from './text.js';

export const MAX_FORMAT = 'ielts-max-result/v1';
const OUTCOMES = ['pass', 'needs_work', 'not_assessed'];
const EVIDENCE = ['audio', 'transcript', 'none'];

export function newBatchId() {
  return 'mx-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function buildMaxPrompt(entries, batchId, today) {
  const lines = entries.map((e, i) => {
    const f = e.fields;
    const usage = (f.usage || '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join('; ');
    const ctx = f.context ? `\n   Where I met it (original context): "${f.context.length > 220 ? f.context.slice(0, 220) + '…' : f.context}"` : '';
    return `${i + 1}. [${e.id}] "${f.term}"${f.ipa ? ` ${f.ipa}` : ''}\n   Meaning (Vietnamese): ${gloss(f.meaning, 160)}\n   Target usage: ${usage || '(use it naturally in an IELTS-style sentence)'}${ctx}${f.topic ? `\n   Topic: ${f.topic}` : ''}`;
  });
  const example = {
    format: MAX_FORMAT,
    batchId,
    assessedAt: today,
    mode: 'voice',
    results: [{
      id: entries[0]?.id || 'v-xxxxxxxx',
      term: entries[0]?.fields.term || 'word',
      pronunciation: 'pass | needs_work | not_assessed',
      pronunciationEvidence: 'audio | transcript | none',
      usage: 'pass | needs_work | not_assessed',
      sentence: "Justin's sentence, as you understood it",
      feedback: 'one short, kind sentence',
    }],
  };
  return [
    `Hi Max! Please run a short speaking check with me (Justin) on ${entries.length === 1 ? 'this IELTS word/phrase' : `these ${entries.length} IELTS words/phrases`}.`,
    '',
    'For each item: ask me to (1) say it, then (2) use it in my own sentence with the target meaning. Give brief, friendly feedback. One item at a time.',
    '',
    lines.join('\n'),
    '',
    'Assessment rules (important):',
    '- "pronunciation": judge ONLY if you actually heard my voice in voice mode. If you only have text or a transcript, use "not_assessed" and set pronunciationEvidence to "transcript" or "none". Never guess.',
    '- "pronunciation": "pass" = understandable to an examiner (an accent is fine).',
    '- "usage": "pass" = my sentence used the target meaning correctly and naturally enough for IELTS.',
    '- If we skipped an item, use "not_assessed" for both.',
    '- Keep each id exactly as written in [brackets].',
    '',
    'When we finish, reply with ONLY this JSON (no other text), one result per item:',
    '```json',
    JSON.stringify(example, null, 2),
    '```',
  ].join('\n');
}

export function extractJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Không tìm thấy JSON trong nội dung đã dán.');
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch (e) {
    throw new Error('JSON không hợp lệ: ' + e.message);
  }
}

// Returns { ok, errors, warnings, rows, batchId, assessedAt, mode }. Nothing is applied here.
export function validateMaxResult(obj, { entriesById, states, exports = [], importedBatches = [], today }) {
  const errors = [], warnings = [], rows = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['Không phải đối tượng JSON.'], warnings, rows };
  if (obj.format !== MAX_FORMAT) errors.push(`"format" phải là "${MAX_FORMAT}".`);
  const batchId = typeof obj.batchId === 'string' ? obj.batchId.trim() : '';
  if (!batchId) warnings.push('Thiếu "batchId" — không đối chiếu được với lần xuất nào.');
  const exp = exports.find((x) => x.batchId === batchId);
  if (batchId && !exp) warnings.push(`Không thấy lần xuất "${batchId}" trên máy này.`);
  if (batchId && importedBatches.includes(batchId)) warnings.push(`Lô "${batchId}" đã từng được nhập. Nhập lại sẽ thêm bản ghi mới (bản cũ vẫn giữ).`);
  const mode = obj.mode === 'voice' || obj.mode === 'text' ? obj.mode : 'unknown';
  if (mode === 'unknown') warnings.push('Không rõ "mode" (voice/text) — phát âm chỉ được chấp nhận khi có bằng chứng audio.');
  const date = obj.assessedAt;
  if (!isYmd(date)) errors.push('"assessedAt" phải có dạng YYYY-MM-DD.');
  else if (today && date > today) errors.push('"assessedAt" nằm trong tương lai.');
  else if (exp && date < exp.date) warnings.push('"assessedAt" sớm hơn ngày xuất lời nhắn.');
  if (!Array.isArray(obj.results) || !obj.results.length) errors.push('"results" phải là danh sách không rỗng.');
  const seen = new Set();
  for (const [i, r] of (Array.isArray(obj.results) ? obj.results : []).entries()) {
    const where = `Kết quả #${i + 1}`;
    const rowErr = [], rowWarn = [];
    const id = typeof r?.id === 'string' ? r.id.trim() : '';
    const entry = entriesById.get(id);
    if (!id) rowErr.push('thiếu "id"');
    else if (!entry) rowErr.push(`ID "${id}" không có trong danh sách từ`);
    if (id && seen.has(id)) rowErr.push(`ID "${id}" bị lặp`);
    seen.add(id);
    if (entry && r.term && norm(r.term) !== norm(entry.fields.term)) rowWarn.push(`từ "${r.term}" khác với "${entry.fields.term}" của ID này`);
    if (exp && id && !exp.ids.includes(id)) rowWarn.push('ID này không nằm trong lần xuất');
    let pron = r?.pronunciation ?? 'not_assessed';
    let usage = r?.usage ?? 'not_assessed';
    if (!OUTCOMES.includes(pron)) { rowErr.push(`"pronunciation" không hợp lệ: ${JSON.stringify(pron)}`); pron = 'not_assessed'; }
    if (!OUTCOMES.includes(usage)) { rowErr.push(`"usage" không hợp lệ: ${JSON.stringify(usage)}`); usage = 'not_assessed'; }
    let evidence = EVIDENCE.includes(r?.pronunciationEvidence) ? r.pronunciationEvidence : 'none';
    if (pron !== 'not_assessed' && (evidence !== 'audio' || mode === 'text')) {
      rowWarn.push('phát âm không có bằng chứng audio → giữ "chưa đánh giá"');
      pron = 'not_assessed';
    }
    const feedback = typeof r?.feedback === 'string' ? r.feedback.slice(0, 500) : '';
    const sentence = typeof r?.sentence === 'string' ? r.sentence.slice(0, 300) : '';
    const s = entry ? states.get(entry.id) : null;
    const effect = [];
    if (entry && s) {
      const pOk = pron === 'pass' || (pron === 'not_assessed' && s.maxPron?.value === 'pass');
      const uOk = usage === 'pass' || (usage === 'not_assessed' && s.maxUsage?.value === 'pass');
      if (s.archived && (pron === 'needs_work' || usage === 'needs_work')) effect.push('đưa về học lại');
      else if (!s.archived && pOk && uOk && s.recallMet) effect.push('→ Đã thuộc (lưu trữ)');
      else if (!s.archived && pOk && uOk) effect.push('Max đã xác nhận; còn chờ đủ điều kiện nhớ');
    }
    rows.push({ index: i, id, term: entry?.fields.term || r?.term || '', pronunciation: pron, pronunciationEvidence: evidence, usage, feedback, sentence, errors: rowErr, warnings: rowWarn, effect, before: s ? { pron: s.maxPron?.value || 'not_assessed', usage: s.maxUsage?.value || 'not_assessed' } : null });
    rowErr.forEach((m) => errors.push(`${where}: ${m}`));
    rowWarn.forEach((m) => warnings.push(`${where}: ${m}`));
  }
  return { ok: errors.length === 0, errors, warnings, rows, batchId, assessedAt: date, mode };
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Origin record attached to every imported result, shown in the word's history.
export function originFor({ batchId, mode, rawHash, deviceId }) {
  return {
    source: 'Max (ChatGPT)',
    via: 'Justin dán vào app (app không tự xác minh được tác giả)',
    batchId: batchId || null,
    mode,
    importedAt: new Date().toISOString(),
    deviceId,
    rawSha256: rawHash,
  };
}
