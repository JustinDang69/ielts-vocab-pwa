import { esc, markSpan } from './dom.js';
import { M } from '../model.js';
import { S, pending, refreshState } from '../sync.js';
import { STATUS_LABEL } from '../core/state.js';
import { findTerm, stripTranslation } from '../core/text.js';
import { fmtDateTime } from '../core/dates.js';
import { ttsAvailable } from '../tts.js';

export function syncBadge() {
  refreshState();
  const p = pending().length;
  const last = S.lastSuccessAt ? fmtDateTime(S.lastSuccessAt) : '';
  let cls = 'ok', text;
  if (M.mode === 'demo') { cls = 'demo'; text = 'DEMO · không đồng bộ'; }
  else if (M.mode === 'file') { cls = 'demo'; text = 'File CSV · chỉ trên máy'; }
  else if (S.state === 'unconfigured') { cls = 'warn'; text = 'Chưa kết nối Google'; }
  else if (S.state === 'syncing') { cls = 'busy'; text = 'Đang đồng bộ…'; }
  else if (p) {
    cls = 'warn';
    text = `${p} thay đổi chỉ trên máy` + (S.state === 'offline' ? ' · ngoại tuyến' : S.state === 'error' ? ' · lỗi' : '');
  } else if (S.state === 'error') { cls = 'warn'; text = 'Lỗi đồng bộ'; }
  else if (S.state === 'offline') { cls = 'warn'; text = last ? `Ngoại tuyến · Google lúc ${last}` : 'Ngoại tuyến'; }
  else if (last) { text = `Đã lưu lên Google · ${last}`; }
  else { cls = 'warn'; text = 'Chưa đồng bộ lần nào'; }
  return `<a class="sync-badge ${cls}" href="#/settings" aria-label="Trạng thái đồng bộ: ${esc(text)}"><span class="dot"></span>${esc(text)}</a>`;
}

export function statusPill(status) {
  return `<span class="pill st-${status}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

export function speakBtn(term, small = false) {
  if (!ttsAvailable()) return '';
  return `<button class="btn speak ${small ? 'small' : ''}" data-speak="${esc(term)}" aria-label="Nghe phát âm mẫu ${esc(term)}">🔊 <span>Nghe mẫu</span></button>`;
}

export function originLabel(origin) {
  return origin === 'example'
    ? '<span class="tag gen">Ví dụ bổ sung – không phải câu gốc</span>'
    : '<span class="tag orig">Câu gốc / Ngữ cảnh</span>';
}

// Full information about an entry (shown only AFTER an attempt or on the detail screen).
// Original context and the Sheet's extra examples are always labelled separately.
export function wordInfo(e, { compact = false } = {}) {
  const f = e.fields;
  const ctx = f.context ? findTerm(f.context, f.term) : null;
  const sec = (label, html, cls = '') => (html ? `<section class="info ${cls}"><h4>${label}</h4><div>${html}</div></section>` : '');
  return `
    <div class="word-head">
      <div><div class="term">${esc(f.term)}</div>
      <div class="muted small">${esc(f.type)}${f.ipa ? ` · <span class="ipa">${esc(f.ipa)}</span>` : ''}</div></div>
      ${speakBtn(f.term, true)}
    </div>
    ${sec('Nghĩa trong ngữ cảnh', esc(f.meaning))}
    ${sec(`Câu gốc / Ngữ cảnh <span class="src">${M.mode === 'demo' ? 'câu mẫu demo' : M.mode === 'file' ? 'từ file CSV' : 'từ Sheet'}</span>`, f.context ? (ctx ? markSpan(f.context, ctx.start, ctx.end) : esc(f.context)) + (f.source ? `<div class="muted small">Nguồn: ${esc(f.source)}</div>` : '') : '', 'orig')}
    ${!f.context && !compact ? sec('Câu gốc / Ngữ cảnh', '<span class="muted">Chưa có câu gốc trong Sheet.</span>', 'orig') : ''}
    ${sec('Ví dụ bổ sung <span class="src">không phải câu gốc</span>', esc(f.example), 'gen')}
    ${sec('Cách dùng / Collocations', esc(f.usage))}
    ${sec('Ghi chú / Lỗi dễ nhầm', esc(compact && f.note.length > 220 ? f.note.slice(0, 220) + '…' : f.note), 'note')}
    ${ttsAvailable() ? '<p class="fine">🔊 Nghe mẫu là giọng máy của thiết bị — nghe không có nghĩa là đã phát âm đúng. Phát âm do Max kiểm tra.</p>' : ''}
  `;
}

export function sentenceWithBlank(b) {
  return `${esc(b.before)}<span class="blank">${esc(b.blank)}</span>${esc(b.after)}`;
}

export { stripTranslation };
