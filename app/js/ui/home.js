import { esc } from './dom.js';
import { M, counts, getSession, setSession, saveSettings } from '../model.js';
import { KIND_LABEL } from '../core/exercises.js';

export const MODES = {
  chill: { icon: '🃏', name: 'Chill Cards', desc: 'Lật thẻ thong thả: từ → gợi ý ngữ cảnh → nghĩa.' },
  quick: { icon: '⚡', name: 'Quick Play', desc: 'Bài ngắn trộn: chọn nghĩa, điền vào câu, tự nhớ từ.' },
  detective: { icon: '🔍', name: 'IELTS Detective', desc: 'Ghép paraphrase, phân biệt nghĩa dễ nhầm.' },
};

export async function renderHome(root, go) {
  const c = counts();
  const sess = await getSession();
  const resumable = sess && !sess.finished && Date.now() - Date.parse(sess.startedAt) < 36 * 3600e3;
  const mode = M.settings.preferredMode || 'quick';
  const total = M.entries.filter((e) => e.inSheet !== false).length;
  root.innerHTML = `
    <div class="home">
      <h1 class="hello">Chào Justin <span aria-hidden="true">👋</span></h1>
      ${M.mode === 'demo' ? '<div class="banner demo">Đây là <b>chế độ DEMO</b> với từ mẫu — không phải dữ liệu thật, không đồng bộ Google.</div>' : ''}
      ${M.mode === 'file' ? '<div class="banner demo"><b>Chế độ file CSV</b> — dữ liệu chỉ nằm trên máy này, không đồng bộ Google.</div>' : ''}
      <div class="stats card">
        <a href="#/library?f=review"><b>${c.due}</b><span>cần ôn</span></a>
        <a href="#/library?f=new"><b>${c.new}</b><span>từ mới</span></a>
        <a href="#/library?f=learning"><b>${c.learning}</b><span>đang học</span></a>
        <a href="#/library?f=mastered"><b>${c.mastered}</b><span>đã thuộc</span></a>
      </div>
      ${!total ? `<div class="card empty">Chưa có từ nào. ${M.mode === 'live' ? 'Vào <a href="#/settings">Cài đặt</a> để kết nối và đồng bộ.' : ''}</div>` : ''}
      ${resumable ? `
        <div class="card resume">
          <div><div class="small muted">Phiên đang dở</div>
          <b>${esc(MODES[sess.mode]?.name || sess.mode)} · ${sess.minutes} phút</b>
          <div class="small muted">${Math.min(sess.index, sess.queue.length)}/${sess.queue.length} mục</div></div>
          <div class="row"><button class="btn primary" data-act="resume">Tiếp tục</button>
          <button class="btn ghost small" data-act="drop">Bỏ</button></div>
        </div>` : ''}
      <div class="mode-pick" role="radiogroup" aria-label="Chế độ học">
        ${Object.entries(MODES).map(([k, m]) => `
          <button role="radio" aria-checked="${k === mode}" class="mode ${k === mode ? 'on' : ''}" data-mode="${k}">
            <span class="mi" aria-hidden="true">${m.icon}</span><span class="mn">${m.name}</span>
          </button>`).join('')}
      </div>
      <p class="mode-desc muted">${esc(MODES[mode].desc)}</p>
      <div class="go">
        ${[2, 5, 10].map((n) => `<button class="btn big ${n === 5 ? 'primary' : 'soft'}" data-start="${n}" ${total ? '' : 'disabled'}>Học ${n} phút</button>`).join('')}
      </div>
      <p class="fine center">Không đếm giờ, không chuỗi ngày bắt buộc. Dừng lúc nào cũng được — phiên sẽ được lưu.</p>
    </div>`;
  root.onclick = async (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { await saveSettings({ preferredMode: m.dataset.mode }); renderHome(root, go); return; }
    const s = e.target.closest('[data-start]');
    if (s) { go('session', { minutes: Number(s.dataset.start), mode }); return; }
    const a = e.target.closest('[data-act]');
    if (a?.dataset.act === 'resume') go('session', { resume: true });
    if (a?.dataset.act === 'drop') { await setSession(null); renderHome(root, go); }
  };
}

export { KIND_LABEL };
