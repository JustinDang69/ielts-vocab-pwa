import { esc, toast, confirmSheet, download, readFile } from './dom.js';
import { M, switchMode, saveConn, saveConfig, saveSettings, reload, APP_VERSION } from '../model.js';
import { S, call, syncNow, pending, rejected } from '../sync.js';
import { fmtDateTime } from '../core/dates.js';
import { makeBackup, validateBackup, planMerge } from '../core/backup.js';
import { entriesFromCSV } from '../core/csv.js';
import { englishVoices, speak, ttsAvailable } from '../tts.js';

const MODE_LABEL = { live: 'Google Sheet (thật, có đồng bộ)', demo: 'DEMO – từ mẫu, không đồng bộ', file: 'File CSV – chỉ trên máy, không đồng bộ' };

export function renderWelcome(root, go) {
  root.innerHTML = `
    <div class="welcome">
      <div class="end-hero"><div class="emoji" aria-hidden="true">🌿</div><h1>Chào Justin!</h1>
      <p class="muted">Học từ vựng IELTS 2–10 phút mỗi lần. Chọn nguồn dữ liệu:</p></div>
      <button class="btn big primary" data-m="live">Kết nối Google Sheet của mình</button>
      <p class="fine">Cần làm bước cài đặt Apps Script một lần (xem hướng dẫn README).</p>
      <button class="btn big soft" data-m="demo">Dùng thử với từ mẫu (DEMO)</button>
      <button class="btn big soft" data-m="file">Nhập file CSV xuất từ Sheet</button>
      <p class="fine">Chế độ DEMO và CSV không đồng bộ với Google và được lưu riêng, không trộn với dữ liệu thật.</p>
    </div>`;
  root.onclick = async (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m) return;
    await switchMode(m);
    if (m === 'file') { await importCsv(); go('home'); } else if (m === 'live') go('settings'); else go('home');
  };
}

async function importCsv() {
  const f = await readFile('.csv,text/csv');
  if (!f) return;
  const { entries, warnings } = entriesFromCSV(f.text);
  if (!entries.length) { toast(warnings[0] || 'Không đọc được từ nào.'); return; }
  const have = new Map(M.entries.map((e) => [e.id, e]));
  const fresh = new Set(entries.map((e) => e.id));
  const gone = M.entries.filter((e) => !fresh.has(e.id) && e.inSheet !== false).map((e) => ({ ...e, inSheet: false }));
  await M.db.putMany('entries', [...entries.map((e) => ({ ...have.get(e.id), ...e, inSheet: true })), ...gone]);
  await reload();
  toast(`Đã nhập ${entries.length} từ.${warnings.length ? ' ' + warnings.join(' ') : ''}`);
}

export function renderSettings(root, go) {
  const p = pending().length;
  const rj = rejected();
  const voices = englishVoices();
  root.innerHTML = `
    <div class="settings">
      <h1>Cài đặt</h1>

      <div class="card">
        <h3>Nguồn dữ liệu</h3>
        <p><b>${esc(MODE_LABEL[M.mode])}</b></p>
        <div class="row wrap">
          ${['live', 'demo', 'file'].filter((m) => m !== M.mode).map((m) => `<button class="btn ghost small" data-mode="${m}">Chuyển sang ${m === 'live' ? 'Google' : m === 'demo' ? 'DEMO' : 'CSV'}</button>`).join('')}
        </div>
        <p class="fine">Mỗi nguồn có dữ liệu riêng trên máy; chuyển qua lại không xóa gì.</p>
        ${M.mode === 'file' ? '<button class="btn soft" data-act="csv">Nhập lại / cập nhật file CSV</button><p class="fine">Trên máy tính: Sheet → Tệp → Tải xuống → CSV (tab Vocab & Phrases). ID ở chế độ này là ID tạm trên máy, không phải ID của Sheet.</p>' : ''}
      </div>

      ${M.mode === 'live' ? `
      <div class="card">
        <h3>Kết nối Google</h3>
        <label class="field">URL Web App (Apps Script)<input id="url" type="url" inputmode="url" autocapitalize="none" autocorrect="off" value="${esc(M.conn.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label class="field">Mã kết nối (token)<input id="token" type="password" autocapitalize="none" autocorrect="off" autocomplete="off" value="${esc(M.conn.token)}" placeholder="dán mã từ Apps Script"></label>
        <button class="btn primary" data-act="connect">Kiểm tra & lưu</button>
        <p class="fine">Mã chỉ lưu trên thiết bị này. Nếu lộ mã: chạy <span class="mono">rotateToken</span> trong Apps Script và nhập mã mới.</p>
      </div>
      <div class="card">
        <h3>Đồng bộ</h3>
        <dl class="kv">
          <dt>Trạng thái</dt><dd>${esc(stateText())}</dd>
          <dt>Lần lưu lên Google gần nhất</dt><dd>${S.lastSuccessAt ? esc(fmtDateTime(S.lastSuccessAt)) : '<b>chưa có</b>'}</dd>
          <dt>Chỉ có trên máy (chờ gửi)</dt><dd><b>${p}</b> thay đổi</dd>
          ${rj.length ? `<dt>Bị máy chủ từ chối</dt><dd>${rj.length}: ${esc([...new Set(rj.map((e) => e._rejected))].join(', '))}</dd>` : ''}
          ${S.lastError ? `<dt>Lỗi gần nhất</dt><dd>${esc(S.lastError)}</dd>` : ''}
        </dl>
        ${S.vocabWarnings.length ? `<div class="fb neutral small">${S.vocabWarnings.map(esc).join('<br>')}</div>` : ''}
        <button class="btn soft" data-act="sync">Đồng bộ ngay</button>
        ${S.log.length ? `<details><summary class="small">Nhật ký</summary><ul class="history">${S.log.map((l) => `<li class="small"><span class="muted">${esc(fmtDateTime(l.at))}</span> ${esc(l.msg)}</li>`).join('')}</ul></details>` : ''}
      </div>` : ''}

      <div class="card">
        <h3>Quy tắc "nhớ chắc"</h3>
        <p class="small">Một từ được coi là nhớ khi bạn <b>tự gõ đúng, không gợi ý</b> vào
        <select id="rd">${[1, 2, 3, 4, 5, 6].map((n) => `<option ${n === M.config.requiredDates ? 'selected' : ''}>${n}</option>`).join('')}</select> ngày khác nhau,
        trong đó ít nhất <select id="rc">${[0, 1, 2, 3].map((n) => `<option ${n === M.config.requiredContextual ? 'selected' : ''}>${n}</option>`).join('')}</select> lần là bài trong ngữ cảnh (điền vào câu / paraphrase), và lần gần nhất đúng.</p>
        <p class="fine">Không tính: chọn đáp án (nhận diện), xem đáp án, tự đánh giá "Nhớ rồi", làm lại ngay trong cùng phiên, hoặc có dùng gợi ý. Nhiều lần trong cùng một ngày chỉ tính 1 ngày.</p>
        <p class="small">Đủ điều kiện → <b>Đã thuộc</b>: cất vào kho, chỉ thỉnh thoảng ôn duy trì.</p>
        <p class="fine">App ghi <b>Trạng thái</b> (Learning / Review / Mastered) và <b>Ngày ôn gần nhất</b> lên Sheet sau mỗi lần đồng bộ, để Max xem và chọn từ luyện nói.</p>
      </div>

      <div class="card">
        <h3>Lịch ôn (minh bạch)</h3>
        <p class="small">Mỗi từ ở một "hộp". Lần làm đầu tiên trong ngày quyết định:</p>
        <ul class="plain small"><li>Tự nhớ đúng, không gợi ý → lên 1 hộp</li><li>Nhận diện / có gợi ý / "lơ mơ" → giữ hộp</li><li>Chưa đúng / xem đáp án → xuống 1 hộp, ôn lại ngày mai</li></ul>
        <p class="small">Khoảng cách theo hộp 0→${M.config.intervals.length - 1}: <span class="mono">${M.config.intervals.join(' · ')}</span> ngày.
        Từ đã thuộc: ôn duy trì sau <span class="mono">${M.config.maintenanceIntervals.join(' · ')}</span> ngày; quên thì tự quay lại hàng học.</p>
      </div>

      ${ttsAvailable() ? `<div class="card">
        <h3>Nghe mẫu</h3>
        <label class="field">Giọng<select id="voice"><option value="">Tự chọn (ưu tiên en-GB)</option>
          ${voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === M.settings.voiceURI ? 'selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('')}</select></label>
        <label class="field">Tốc độ <input id="rate" type="range" min="0.6" max="1.1" step="0.05" value="${M.settings.rate}"></label>
        <button class="btn ghost small" data-act="testVoice">🔊 Thử: “consensus”</button>
        <p class="fine">Chỉ phát khi bạn bấm. Đây là giọng máy, không phải bằng chứng phát âm.</p>
      </div>` : ''}

      <div class="card">
        <h3>Sao lưu & khôi phục</h3>
        <button class="btn soft" data-act="backup">⬇︎ Xuất bản sao lưu (.json)</button>
        <button class="btn ghost" data-act="restore">⬆︎ Khôi phục từ file…</button>
        <p class="fine">Khôi phục là <b>gộp</b>: chỉ thêm sự kiện/mục còn thiếu, không xóa gì. ${M.mode === 'live' ? 'Sự kiện được khôi phục sẽ được gửi lên Google ở lần đồng bộ sau (không trùng lặp).' : ''}
        Bộ nhớ lâu dài: ${M.persisted ? 'đã được trình duyệt cấp' : 'chưa được cấp — hãy cài app ra Màn hình chính'}.</p>
      </div>

      <div class="card small muted">
        <h3>Thông tin</h3>
        <p>Phiên bản ${APP_VERSION} · thiết bị <span class="mono">${esc(M.deviceId)}</span> · ${M.entries.length} mục · ${M.events.length} sự kiện</p>
      </div>
    </div>`;
  bind(root, go);
}

function stateText() {
  return { idle: 'Sẵn sàng', syncing: 'Đang đồng bộ…', offline: 'Ngoại tuyến — thay đổi được lưu trên máy', error: 'Lỗi — sẽ tự thử lại', unconfigured: 'Chưa nhập URL / mã kết nối', not_live: 'Không đồng bộ (không phải chế độ Google)' }[S.state] || S.state;
}

function bind(root, go) {
  root.onchange = async (e) => {
    if (e.target.id === 'rd' || e.target.id === 'rc') {
      await saveConfig({ requiredDates: Number(root.querySelector('#rd').value), requiredContextual: Number(root.querySelector('#rc').value) });
      toast('Đã lưu quy tắc.');
    }
    if (e.target.id === 'voice') await saveSettings({ voiceURI: e.target.value });
    if (e.target.id === 'rate') await saveSettings({ rate: Number(e.target.value) });
  };
  root.onclick = async (e) => {
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m) { await switchMode(m); if (m === 'file' && !M.entries.length) await importCsv(); renderSettings(root, go); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    if (a === 'csv') { await importCsv(); renderSettings(root, go); }
    if (a === 'testVoice') speak('consensus', M.settings);
    if (a === 'sync') { toast('Đang đồng bộ…'); const ok = await syncNow('manual'); toast(ok ? 'Đã đồng bộ với Google.' : 'Chưa đồng bộ được: ' + (S.lastError || S.state)); renderSettings(root, go); }
    if (a === 'connect') {
      const url = root.querySelector('#url').value.trim();
      const token = root.querySelector('#token').value.trim();
      if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) { toast('URL phải bắt đầu bằng https://'); return; }
      try {
        await call({ action: 'ping' }, { url, token });
        await saveConn({ url, token });
        toast('Kết nối được! Đang đồng bộ…');
        const ok = await syncNow('connect');
        toast(ok ? `Đã đồng bộ ${M.entries.length} từ.` : 'Kết nối được nhưng đồng bộ lỗi: ' + S.lastError);
      } catch (err) { toast('Chưa kết nối được: ' + err.message); }
      renderSettings(root, go);
    }
    if (a === 'backup') {
      const b = makeBackup({ mode: M.mode, deviceId: M.deviceId, entries: M.entries, events: M.events, settings: { config: M.config, settings: M.settings }, appVersion: APP_VERSION });
      const name = `ielts-vocab-${M.mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
      await download(name, JSON.stringify(b, null, 1));
    }
    if (a === 'restore') {
      const f = await readFile('.json,application/json');
      if (!f) return;
      let b;
      try { b = JSON.parse(f.text); } catch { toast('File không phải JSON.'); return; }
      const errs = validateBackup(b);
      if (errs.length) { toast(errs[0]); return; }
      const plan = planMerge(b, { events: M.events, entries: M.entries, mode: M.mode });
      const ok = await confirmSheet({
        title: 'Khôi phục (gộp) từ sao lưu?',
        body: `File: ${esc(f.name)}<br>Xuất lúc ${esc(fmtDateTime(b.exportedAt))} · chế độ ${esc(b.mode)}<br>Sẽ thêm <b>${plan.newEvents.length}</b> sự kiện và <b>${plan.newEntries.length}</b> mục còn thiếu; bỏ qua ${plan.skippedEvents} sự kiện đã có.${plan.modeMismatch ? '<br><b>Lưu ý:</b> file thuộc chế độ khác với chế độ hiện tại.' : ''}`,
        ok: 'Khôi phục',
      });
      if (!ok) return;
      // Restored events keep their original eventId, so the server de-duplicates them.
      await M.db.putMany('events', plan.newEvents.map(({ synced, ...ev }) => ({ ...ev, _synced: 0 })));
      await M.db.putMany('entries', plan.newEntries);
      await reload();
      toast(`Đã khôi phục ${plan.newEvents.length} sự kiện.`);
      renderSettings(root, go);
    }
  };
}
