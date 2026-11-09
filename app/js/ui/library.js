import { esc, confirmSheet, toast } from './dom.js';
import { M, entry, state, addEvent } from '../model.js';
import { STATUS_LABEL, explainRecall } from '../core/state.js';
import { KIND_LABEL } from '../core/exercises.js';
import { norm } from '../core/text.js';
import { fmtDate, fmtDateTime } from '../core/dates.js';
import { wordInfo, statusPill } from './common.js';
import { schedule } from '../sync.js';

const FILTERS = [
  ['all', 'Tất cả'], ['review', 'Cần ôn'], ['new', 'Mới'], ['learning', 'Đang học'],
  ['mastered', 'Đã thuộc (lưu trữ)'], ['removed', 'Không còn trong Sheet'],
];

let query = '';

export function renderLibrary(root, params) {
  const f = params.f || 'all';
  const count = (k) => (k === 'all' ? [...M.states.values()].filter((s) => s.status !== 'removed').length
    : k === 'review' ? [...M.states.values()].filter((s) => s.status === 'review').length
      : [...M.states.values()].filter((s) => s.status === k).length);
  root.innerHTML = `
    <div class="library">
      <h1>Kho từ</h1>
      <input class="search" type="search" placeholder="Tìm từ, nghĩa, chủ đề…" value="${esc(query)}" aria-label="Tìm kiếm" autocapitalize="none" autocorrect="off">
      <div class="chips" role="tablist">
        ${FILTERS.map(([k, l]) => `<a role="tab" aria-selected="${k === f}" class="chip ${k === f ? 'on' : ''}" href="#/library?f=${k}">${l} <span>${count(k)}</span></a>`).join('')}
      </div>
      <ul class="list" id="list"></ul>
    </div>`;
  const list = root.querySelector('#list');
  const draw = () => {
    const q = norm(query);
    const rows = M.entries.filter((e) => {
      const s = state(e.id);
      if (!s) return false;
      if (f === 'all' ? s.status === 'removed' : s.status !== f) return false;
      if (!q) return true;
      return [e.fields.term, e.fields.meaning, e.fields.topic, e.fields.note, e.id].some((x) => norm(x).includes(q));
    });
    list.innerHTML = rows.length ? rows.map((e) => {
      const s = state(e.id);
      const next = s.archived ? (s.nextMaintenance ? `ôn duy trì ${fmtDate(s.nextMaintenance)}` : '') : s.nextReview ? `ôn ${fmtDate(s.nextReview)}` : '';
      return `<li><a href="#/word/${encodeURIComponent(e.id)}"><span class="lt">${esc(e.fields.term)}</span>
        <span class="lm">${statusPill(s.status)} <span class="small muted">${esc(next)}</span></span></a></li>`;
    }).join('') : '<li class="empty muted">Không có mục nào.</li>';
  };
  draw();
  root.querySelector('.search').addEventListener('input', (e) => { query = e.target.value; draw(); });
  root.onclick = null;
}

const SPEAK = { pass: 'Đạt', needs_work: 'Cần luyện thêm', not_assessed: 'Chưa đánh giá' };
const SUPPORT = { none: 'tự nói, không gợi ý', hint: 'có gợi ý', model: 'nhắc lại theo mẫu', unknown: 'không rõ mức hỗ trợ' };
const OUT_LABEL = { correct: 'đúng', wrong: 'chưa đúng', revealed: 'xem đáp án', other_term: 'từ gần nghĩa', self_known: 'tự đánh giá: nhớ', self_unsure: 'tự đánh giá: lơ mơ', self_unknown: 'tự đánh giá: chưa nhớ' };
function historyLine(ev) {
  const d = ev.data || {};
  let t = '';
  if (ev.type === 'review') t = `${KIND_LABEL[d.exercise] || d.exercise}: ${OUT_LABEL[d.outcome] || d.outcome}${d.assisted ? ' (có gợi ý)' : ''}${d.retry ? ' (gặp lại trong phiên)' : ''}${d.maintenance ? ' (ôn duy trì)' : ''}`;
  else if (ev.type === 'speaking') t = `🎤 Speaking: cách dùng ${SPEAK[d.usage] || d.usage}, phát âm ${SPEAK[d.pronunciation] || d.pronunciation} (${SUPPORT[d.support] || d.support})`;
  else if (ev.type === 'mastered') t = '🏆 Đã thuộc → lưu trữ';
  else if (ev.type === 'restore') t = `↩︎ Đưa về học lại${d.reason === 'maintenance_failed' ? ' (quên khi ôn duy trì)' : ''}`;
  return `<li><span class="small muted">${esc(fmtDate(ev.studyDate))}</span> ${esc(t)}${ev._synced ? '' : ' <span class="tag local" title="Chưa lên Google">trên máy</span>'}</li>`;
}

export function renderWord(root, id, go) {
  const e = entry(id);
  const s = state(id);
  if (!e || !s) { root.innerHTML = '<p class="muted">Không tìm thấy mục này.</p>'; return; }
  const interval = s.nextReview && s.lastStudyDate ? `hộp ${s.box} (${M.config.intervals[s.box]} ngày)` : '';
  root.innerHTML = `
    <div class="word">
      <a class="back" href="#/library">← Kho từ</a>
      <div class="row between">${statusPill(s.status)}<span class="small muted mono">ID ${esc(e.id)}</span></div>
      ${s.status === 'removed' ? '<div class="banner">Mục này không còn thấy trong Sheet. Lịch sử học vẫn được giữ.</div>' : ''}
      <div class="card">${wordInfo(e)}
        <div class="small muted">${esc([e.fields.topic, e.fields.skill, e.fields.dateAdded && 'thêm ' + fmtDate(e.fields.dateAdded)].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="card">
        <h3>Nhớ & hiểu ngữ cảnh</h3>
        <ul class="plain">${explainRecall(s, M.config).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <p class="small muted">${s.archived ? `Đã thuộc từ ${esc(fmtDate(s.masteredAt))}. Ôn duy trì tiếp theo: ${esc(fmtDate(s.nextMaintenance))}.` : s.nextReview ? `Ôn tiếp theo: <b>${esc(fmtDate(s.nextReview))}</b> · ${esc(interval)}` : 'Chưa học lần nào.'}</p>
        <p class="small muted">Lượt làm: ${s.attempts} · dùng gợi ý: ${s.hintsUsed} · chưa đúng: ${s.errors}</p>
      </div>
      ${speakingCard(s)}
      ${s.archived ? `<div class="card"><p class="small">Từ đã thuộc không xuất hiện trong phiên học thường, chỉ thỉnh thoảng ôn duy trì.</p>
        <button class="btn soft" data-act="restore">↩︎ Đưa về học lại</button></div>` : ''}
      <div class="card"><h3>Lịch sử</h3><ul class="history">${s.history.slice(-20).reverse().map(historyLine).join('') || '<li class="muted">Chưa có.</li>'}</ul></div>
    </div>`;
  root.onclick = async (ev) => {
    if (ev.target.closest('[data-act="restore"]')) {
      const ok = await confirmSheet({ title: `Đưa “${e.fields.term}” về học lại?`, body: 'Tiến độ nhớ sẽ tính lại từ đầu. Toàn bộ lịch sử vẫn được giữ.', ok: 'Đưa về học lại' });
      if (!ok) return;
      await addEvent('restore', id, { reason: 'manual' });
      schedule(1500);
      toast('Đã đưa về hàng học.');
      renderWord(root, id, go);
    }
  };
}

function speakingCard(s) {
  if (!s.speakUsage && !s.speakPron) return '';
  const line = (label, rec, extra = '', text = true) => `<div class="maxline"><span>${label}</span> <b class="${rec ? rec.value : 'na'}">${rec ? SPEAK[rec.value] : 'Chưa đánh giá'}</b>
    ${rec ? `<div class="small muted">${esc(fmtDate(rec.at))} · ${esc(rec.source || '')}${extra ? ' · ' + esc(extra) : ''}</div>` : ''}
    ${text && rec?.sentence ? `<div class="small">“${esc(rec.sentence)}”</div>` : ''}${text && rec?.feedback ? `<div class="small muted">${esc(rec.feedback)}</div>` : ''}</div>`;
  const sameResult = s.speakPron && s.speakUsage && s.speakPron.ts === s.speakUsage.ts;
  return `<div class="card"><h3>Speaking (từ chatbot)</h3>
    ${line('Dùng đúng ngữ cảnh', s.speakUsage, s.speakUsage ? SUPPORT[s.speakUsage.support] : '')}
    ${line('Phát âm', s.speakPron, s.speakPron ? 'bot nghe audio' : '', !sameResult)}
    <p class="fine">Tự dùng đúng, không gợi ý = 1 lần nhớ trong ngữ cảnh. Có gợi ý / theo mẫu chỉ ghi lịch sử. Phát âm chỉ tính khi bot nghe audio.</p></div>`;
}

export { STATUS_LABEL };
