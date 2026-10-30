import { esc, toast, confirmSheet } from './dom.js';
import { M, entry, state, makeEvent, addEvents, saveMaxExports, today } from '../model.js';
import { buildMaxPrompt, newBatchId, extractJson, validateMaxResult, sha256Hex, originFor } from '../core/max.js';
import { fmtDate, fmtDateTime } from '../core/dates.js';
import { statusPill } from './common.js';
import { schedule } from '../sync.js';

const LBL = { pass: 'Đạt', needs_work: 'Cần luyện', not_assessed: 'Chưa đánh giá' };
let showAll = false;
let selected = null;
let lastPrompt = '';
let preview = null;

export function renderMax(root) {
  const waiting = M.entries.filter((e) => state(e.id)?.status === 'awaiting_max');
  const others = M.entries.filter((e) => ['learning', 'review'].includes(state(e.id)?.status));
  if (!selected) selected = new Set(waiting.map((e) => e.id));
  const list = showAll ? [...waiting, ...others] : waiting;
  const imported = M.events.filter((e) => e.type === 'max_result');
  const batches = groupBatches(imported);
  root.innerHTML = `
    <div class="max">
      <h1>Max 🎤</h1>
      <p class="muted">App không truy cập được cuộc trò chuyện với Max, micro hay kết quả của Max. Bạn chuyển qua lại bằng sao chép / dán.</p>

      <div class="card">
        <h3>1 · Gửi từ cho Max</h3>
        ${waiting.length ? `<p class="small">${waiting.length} từ đã đủ điều kiện nhớ và đang <b>chờ Max kiểm tra</b>.</p>` : '<p class="small muted">Chưa có từ nào chờ Max. Bạn vẫn có thể gửi từ đang học để luyện.</p>'}
        <ul class="pick">${list.map((e) => `<li><label><input type="checkbox" data-id="${esc(e.id)}" ${selected.has(e.id) ? 'checked' : ''}>
          <span><b>${esc(e.fields.term)}</b> ${statusPill(state(e.id).status)}</span></label></li>`).join('') || ''}</ul>
        ${others.length ? `<button class="btn ghost small" data-act="toggleAll">${showAll ? 'Chỉ hiện từ chờ Max' : `+ Thêm từ đang học (${others.length})`}</button>` : ''}
        <button class="btn primary" data-act="export" ${selected.size ? '' : 'disabled'}>Tạo lời nhắn cho Max (${selected.size})</button>
        ${lastPrompt ? `<textarea class="mono" rows="8" readonly id="prompt">${esc(lastPrompt)}</textarea>
          <div class="row"><button class="btn soft" data-act="copy">📋 Sao chép</button>${navigator.share ? '<button class="btn soft" data-act="share">Chia sẻ…</button>' : ''}</div>
          <p class="fine">Mở ChatGPT, dùng <b>chế độ giọng nói (voice)</b> với Max để Max thật sự nghe bạn. Nếu chỉ nhắn chữ, phát âm sẽ là "chưa đánh giá".</p>` : ''}
      </div>

      <div class="card">
        <h3>2 · Nhập kết quả từ Max</h3>
        <p class="small muted">Dán nguyên văn JSON Max trả về. App sẽ kiểm tra và cho xem trước — chưa thay đổi gì cho tới khi bạn bấm Áp dụng.</p>
        <textarea id="paste" rows="6" class="mono" placeholder='{"format":"ielts-max-result/v1", ...}'></textarea>
        <button class="btn primary" data-act="check">Kiểm tra</button>
        <div id="preview">${preview ? previewHtml(preview) : ''}</div>
      </div>

      <div class="card">
        <h3>Đã nhập</h3>
        ${batches.length ? `<ul class="history">${batches.map((b) => `<li><b>${esc(b.batchId || '(không có mã lô)')}</b> · ${b.count} kết quả · đánh giá ${esc(fmtDate(b.assessedAt))}
          <div class="small muted">Nguồn: ${esc(b.origin?.source || '?')} · ${esc(b.origin?.mode || '')} · ${esc(b.origin?.via || '')} · nhập ${esc(fmtDateTime(b.origin?.importedAt))}</div></li>`).join('')}</ul>` : '<p class="small muted">Chưa có.</p>'}
      </div>
    </div>`;
  bind(root);
}

function groupBatches(evs) {
  const m = new Map();
  for (const e of evs) {
    const k = (e.data?.origin?.batchId || '') + '|' + (e.data?.origin?.importedAt || '');
    if (!m.has(k)) m.set(k, { batchId: e.data?.origin?.batchId, origin: e.data?.origin, assessedAt: e.data?.assessedAt, count: 0 });
    m.get(k).count++;
  }
  return [...m.values()].sort((a, b) => String(b.origin?.importedAt).localeCompare(String(a.origin?.importedAt)));
}

function previewHtml(p) {
  const v = p.v;
  return `
    ${v.errors.length ? `<div class="fb soft"><b>Không thể áp dụng — cần sửa:</b><ul>${v.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${v.warnings.length ? `<div class="fb neutral"><b>Lưu ý:</b><ul>${v.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    <table class="pv"><thead><tr><th>Từ</th><th>Phát âm</th><th>Cách dùng</th></tr></thead><tbody>
    ${v.rows.map((r) => `<tr class="${r.errors.length ? 'bad' : ''}"><td><b>${esc(r.term || r.id)}</b><div class="small muted mono">${esc(r.id)}</div>
      ${r.effect.length ? `<div class="small">${esc(r.effect.join('; '))}</div>` : ''}</td>
      <td>${r.before ? `${LBL[r.before.pron]} → ` : ''}<b>${LBL[r.pronunciation]}</b><div class="small muted">${esc(r.pronunciationEvidence)}</div></td>
      <td>${r.before ? `${LBL[r.before.usage]} → ` : ''}<b>${LBL[r.usage]}</b></td></tr>
      ${r.feedback ? `<tr><td colspan="3" class="small">“${esc(r.feedback)}”</td></tr>` : ''}`).join('')}
    </tbody></table>
    <p class="small muted">Lô: ${esc(v.batchId || '?')} · ngày đánh giá ${esc(fmtDate(v.assessedAt))} · mode: ${esc(v.mode)}</p>
    ${v.ok ? `<button class="btn primary" data-act="apply">Áp dụng ${v.rows.length} kết quả</button>` : ''}`;
}

function bind(root) {
  root.onchange = (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    if (e.target.checked) selected.add(id); else selected.delete(id);
    const btn = root.querySelector('[data-act="export"]');
    btn.textContent = `Tạo lời nhắn cho Max (${selected.size})`;
    btn.disabled = !selected.size;
  };
  root.onclick = async (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    if (a === 'toggleAll') { showAll = !showAll; renderMax(root); }
    if (a === 'export') {
      const ids = [...selected].filter((id) => entry(id));
      const batchId = newBatchId();
      lastPrompt = buildMaxPrompt(ids.map(entry), batchId, today());
      await saveMaxExports([...M.maxExports, { batchId, ids, date: today(), at: new Date().toISOString() }].slice(-50));
      await addEvents([makeEvent('max_export', '*', { batchId, ids })]);
      schedule(3000);
      renderMax(root);
      root.querySelector('#prompt')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (a === 'copy') {
      try { await navigator.clipboard.writeText(lastPrompt); toast('Đã sao chép. Dán vào cuộc trò chuyện với Max.'); } catch { root.querySelector('#prompt').select(); toast('Hãy chọn và sao chép thủ công.'); }
    }
    if (a === 'share') navigator.share({ text: lastPrompt }).catch(() => {});
    if (a === 'check') {
      const raw = root.querySelector('#paste').value;
      try {
        const obj = extractJson(raw);
        const exportsAll = [...M.maxExports, ...M.events.filter((x) => x.type === 'max_export').map((x) => ({ batchId: x.data.batchId, ids: x.data.ids, date: x.studyDate }))];
        const imported = [...new Set(M.events.filter((x) => x.type === 'max_result').map((x) => x.data?.origin?.batchId).filter(Boolean))];
        const v = validateMaxResult(obj, { entriesById: new Map(M.entries.map((x) => [x.id, x])), states: M.states, exports: exportsAll, importedBatches: imported, today: today() });
        preview = { v, raw };
      } catch (err) {
        preview = { v: { ok: false, errors: [err.message], warnings: [], rows: [] }, raw };
      }
      root.querySelector('#preview').innerHTML = previewHtml(preview);
      root.querySelector('#preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (a === 'apply' && preview?.v.ok) {
      const v = preview.v;
      const ok = await confirmSheet({ title: `Áp dụng ${v.rows.length} kết quả của Max?`, body: 'Kết quả được lưu kèm nguồn (lô, ngày, cách nhập). Không xóa kết quả cũ.', ok: 'Áp dụng' });
      if (!ok) return;
      const origin = originFor({ batchId: v.batchId, mode: v.mode, rawHash: await sha256Hex(preview.raw), deviceId: M.deviceId });
      const evs = [];
      for (const r of v.rows) {
        evs.push(makeEvent('max_result', r.id, {
          pronunciation: r.pronunciation, pronunciationEvidence: r.pronunciationEvidence, usage: r.usage,
          feedback: r.feedback, sentence: r.sentence, assessedAt: v.assessedAt, origin,
        }));
        const s = state(r.id);
        if (s?.archived && (r.pronunciation === 'needs_work' || r.usage === 'needs_work')) evs.push(makeEvent('restore', r.id, { reason: 'max_needs_work' }));
      }
      await addEvents(evs);
      schedule(1500);
      preview = null;
      selected = null;
      toast('Đã áp dụng kết quả của Max.');
      renderMax(root);
    }
  };
}
