import { esc, markSpan, toast, $ } from './dom.js';
import { M, entry, state, addEvent, makeEvent, addEvents, getSession, setSession } from '../model.js';
import { planSession, newSession, currentItem, recordAnswer, reviewEventData } from '../core/session.js';
import { gradeTyped, KIND_LABEL } from '../core/exercises.js';
import { gloss, mask, findTerm } from '../core/text.js';
import { wordInfo, sentenceWithBlank, originLabel, speakBtn } from './common.js';
import { MODES } from './home.js';
import { schedule } from '../sync.js';

let S = null;       // current session
let ui = {};        // per-item UI state (hints etc.), mirrored into the queue item

export async function renderSession(root, params, go) {
  if (params.resume) S = await getSession();
  else {
    const plan = planSession({ minutes: params.minutes, mode: params.mode, entries: M.entries, states: M.states, flags: M.flags, config: M.config });
    if (!plan.length) { toast('Không có từ nào để học lúc này.'); go('home'); return; }
    S = newSession({ minutes: params.minutes, mode: params.mode, plan });
    await setSession(S);
  }
  if (!S) { go('home'); return; }
  draw(root, go);
}

async function save() { await setSession(S); }

function draw(root, go) {
  const total = S.queue.length;
  const pos = Math.min(S.index + (S.feedback ? 0 : 1), total);
  while (!S.feedback && !S.finished && !currentItem(S, M.entries)) {
    S.index++; // entry vanished from the Sheet since planning: skip it
    if (S.index >= S.queue.length) S.finished = true;
  }
  if (S.finished && !S.feedback) return drawEnd(root, go);
  const body = S.feedback ? feedbackView() : itemView();
  root.innerHTML = `
    <div class="session">
      <div class="s-top">
        <button class="btn ghost small" data-act="stop" aria-label="Dừng và lưu phiên">✕ Dừng</button>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${pos}"><i style="width:${(100 * pos) / total}%"></i></div>
        <span class="small muted">${MODES[S.mode]?.icon || ''}</span>
      </div>
      <div class="s-body">${body}</div>
    </div>`;
  bind(root, go);
  const inp = $('#answer', root);
  if (inp && !S.feedback) setTimeout(() => inp.focus({ preventScroll: true }), 60);
}

function itemView() {
  const item = currentItem(S, M.entries);
  const q = S.queue[S.index];
  ui = q.ui || (q.ui = { hints: 0, showMeaning: false, showLetters: false, showContext: false, flipped: false });
  const e = entry(item.wordId);
  const tag = `<div class="kind">${esc(KIND_LABEL[item.kind])}${q.retry ? ' · <span class="again">gặp lại</span>' : ''}${q.maintenance ? ' · <span class="again">ôn duy trì</span>' : ''}</div>`;
  const giveUp = '<button class="btn ghost small" data-act="reveal">Không nhớ – xem đáp án</button>';

  if (item.kind === 'card') {
    if (ui.flipped) {
      return `${tag}<div class="card big-card">${wordInfo(e)}</div>
        <div class="s-actions"><p class="muted small center">Bạn nhớ từ này tới đâu? (chỉ để xếp lịch — không tính là "đã thuộc")</p>
        <div class="rate">
          <button class="btn soft" data-rate="self_known">😊 Nhớ rồi</button>
          <button class="btn soft" data-rate="self_unsure">🤔 Lơ mơ</button>
          <button class="btn soft" data-rate="self_unknown">🌱 Chưa nhớ</button>
        </div></div>`;
    }
    return `${tag}<div class="card big-card center">
        <div class="term-big">${esc(e.fields.term)}</div>
        <div class="muted">${esc(e.fields.type)}</div>
        ${ui.showContext && item.hint ? `<div class="hint">${originLabel('original')}<p>${ctxMarked(e)}</p></div>` : ''}
        <p class="muted small">Thử nhớ nghĩa trong đầu trước khi lật.</p>
      </div>
      <div class="s-actions">
        ${item.hint && !ui.showContext ? '<button class="btn soft" data-act="ctx">💡 Gợi ý: xem câu gốc</button>' : ''}
        <button class="btn primary big" data-act="flip">Lật thẻ</button>
      </div>`;
  }

  if (item.options) {
    let prompt = '';
    if (item.kind === 'mcq_meaning') prompt = `<p class="ask">Nghĩa nào đúng?</p><div class="term-big">${esc(item.term)}</div>`;
    if (item.kind === 'context_meaning') prompt = `<p class="ask">Trong câu này, phần được tô đậm nghĩa là gì?</p>${originLabel('original')}<p class="sentence">${markSpan(item.sentence.text, item.sentence.start, item.sentence.end)}</p>`;
    if (item.kind === 'paraphrase_term') prompt = `<p class="ask">Từ nào điền vào chỗ trống với nghĩa <b>“${esc(item.cue)}”</b>?</p>${originLabel(item.origin)}<p class="sentence">${sentenceWithBlank(item.blanked)}</p>`;
    if (item.kind === 'confusable') prompt = `<p class="ask">Hai nghĩa dễ nhầm. <b>${esc(item.term)}</b> là nghĩa nào?</p>`;
    return `${tag}<div class="card">${prompt}</div>
      <div class="s-actions"><div class="options">
        ${item.options.map((o, i) => `<button class="btn opt" data-opt="${i}">${esc(o.text)}</button>`).join('')}
      </div>${giveUp}</div>`;
  }

  // typed
  let prompt = '';
  if (item.kind === 'gapfill_typed') {
    prompt = `<p class="ask">Điền từ / cụm từ còn thiếu</p>${originLabel(item.origin)}<p class="sentence">${sentenceWithBlank(item.blanked)}</p>
      ${ui.showMeaning ? `<p class="hint">Nghĩa: ${esc(item.hintMeaning)}</p>` : ''}`;
  } else if (item.kind === 'paraphrase_typed') {
    prompt = `<p class="ask">Paraphrase → từ gốc. Gõ từ / cụm từ có nghĩa <b>“${esc(item.cue)}”</b>:</p>${originLabel(item.origin)}<p class="sentence">${sentenceWithBlank(item.blanked)}</p>`;
  } else {
    prompt = `<p class="ask">Từ / cụm từ tiếng Anh nào có nghĩa:</p><p class="cue">${esc(item.cue)}</p>
      <p class="muted small">${esc([item.typeLabel, item.topic].filter(Boolean).join(' · '))}</p>`;
  }
  return `${tag}<div class="card">${prompt}
      ${ui.showLetters ? `<p class="hint">Chữ cái đầu: <b>${esc(item.firstLetters)}</b></p>` : ''}
      <form class="answer-row" data-form="typed" autocomplete="off">
        <input id="answer" name="a" type="text" inputmode="text" autocapitalize="none" autocorrect="off" spellcheck="false"
          autocomplete="off" enterkeyhint="done" placeholder="Gõ câu trả lời…" aria-label="Câu trả lời">
        <button class="btn primary" type="submit">Kiểm tra</button>
      </form>
    </div>
    <div class="s-actions hints">
      ${item.kind === 'gapfill_typed' && !ui.showMeaning ? '<button class="btn soft small" data-act="hintMeaning">💡 Gợi ý nghĩa</button>' : ''}
      ${!ui.showLetters ? '<button class="btn soft small" data-act="hintLetters">🔤 Chữ cái đầu</button>' : ''}
      ${giveUp}
    </div>
    ${ui.hints ? '<p class="fine center">Đã dùng gợi ý — lần này vẫn tốt cho trí nhớ, nhưng không tính là "nhớ không cần gợi ý".</p>' : ''}`;
}

function ctxMarked(e) {
  const f = e.fields;
  const m = findTerm(f.context, f.term);
  return m ? markSpan(f.context, m.start, m.end) : esc(f.context);
}

function feedbackView() {
  const fb = S.feedback;
  const e = entry(fb.wordId);
  const st = state(fb.wordId);
  const good = fb.outcome === 'correct';
  let head;
  if (good) head = `<div class="fb good"><b>✓ Chính xác!</b>${fb.typo ? ` <span class="small">Chính tả chuẩn: <b>${esc(fb.expected)}</b></span>` : ''}${fb.assisted ? '<div class="small">(có dùng gợi ý)</div>' : ''}</div>`;
  else if (fb.outcome === 'other_term') {
    const o = entry(fb.otherId);
    head = `<div class="fb neutral"><b>“${esc(o?.fields.term)}”</b> cũng có trong danh sách và gần nghĩa — nhưng ở đây đáp án là <b>${esc(e.fields.term)}</b>. Không tính là sai.</div>`;
  } else {
    const chosen = fb.chosenId && fb.chosenId !== e.id ? entry(fb.chosenId) : null;
    head = `<div class="fb soft"><b>Đáp án: ${esc(e.fields.term)}</b>
      ${fb.answer ? `<div class="small">Bạn gõ: “${esc(fb.answer)}”</div>` : ''}
      ${chosen ? `<div class="small">Lựa chọn của bạn là nghĩa của <b>${esc(chosen.fields.term)}</b>: ${esc(mask(gloss(chosen.fields.meaning), e.fields.term))}</div>` : ''}
      ${fb.requeued ? '<div class="small">🌱 Từ này sẽ quay lại thêm một lần trong phiên này.</div>' : ''}</div>`;
  }
  const partner = fb.partnerId ? entry(fb.partnerId) : null;
  const milestone = st?.status === 'awaiting_max' && fb.becameAwaiting
    ? '<div class="fb celebrate">🎉 Đủ điều kiện nhớ! Từ này đã <b>chờ Max kiểm tra</b> phát âm và cách dùng.</div>' : '';
  return `${head}${milestone}
    <div class="card">${good ? brief(e) : wordInfo(e, { compact: true })}
      ${partner ? `<hr><p class="small muted">So sánh với:</p><div class="term">${esc(partner.fields.term)}</div><p>${esc(partner.fields.meaning)}</p>${partner.fields.note ? `<p class="small">${esc(partner.fields.note)}</p>` : ''}` : ''}
    </div>
    <div class="s-actions">
      <button class="btn primary big" data-act="next">Tiếp →</button>
      ${fb.kind !== 'card' && !fb.flagged ? '<button class="btn ghost small" data-act="flag">Câu hỏi này chưa ổn? Báo lại</button>' : ''}
    </div>`;
}

function brief(e) {
  const f = e.fields;
  return `<div class="word-head"><div><div class="term">${esc(f.term)}</div><div class="muted small">${f.ipa ? `<span class="ipa">${esc(f.ipa)}</span>` : ''}</div></div>${speakBtn(f.term, true)}</div><p>${esc(f.meaning)}</p>`;
}

function bind(root, go) {
  root.onsubmit = async (ev) => {
    if (!ev.target.matches('[data-form="typed"]')) return;
    ev.preventDefault();
    const val = ev.target.a.value;
    const item = currentItem(S, M.entries);
    const e = entry(item.wordId);
    const g = gradeTyped(val, item, e, M.entries);
    await answer({ ...g, answer: val, assisted: ui.hints > 0, hints: ui.hints }, root, go);
  };
  root.onclick = async (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    const item = S.feedback ? null : currentItem(S, M.entries);
    const act = t.dataset.act;
    if (act === 'stop') { await save(); toast('Đã lưu phiên — có thể tiếp tục sau.'); go('home'); return; }
    if (act === 'next') { S.feedback = null; await save(); draw(root, go); return; }
    if (act === 'flag') {
      const fb = S.feedback;
      await addEvent('flag_item', fb.wordId, { itemKey: fb.itemKey, voidEventId: fb.eventId });
      fb.flagged = true; await save();
      toast('Cảm ơn! Câu này sẽ không tính điểm và không hỏi lại kiểu này.');
      draw(root, go); return;
    }
    if (act === 'flip') { ui.flipped = true; await save(); draw(root, go); return; }
    if (act === 'ctx') { ui.showContext = true; ui.hints++; await save(); draw(root, go); return; }
    if (act === 'hintMeaning') { ui.showMeaning = true; ui.hints++; await save(); draw(root, go); return; }
    if (act === 'hintLetters') { ui.showLetters = true; ui.hints++; await save(); draw(root, go); return; }
    if (act === 'reveal') { await answer({ outcome: 'revealed', assisted: ui.hints > 0, hints: ui.hints }, root, go); return; }
    if (t.dataset.rate) { await answer({ outcome: t.dataset.rate, assisted: ui.hints > 0, hints: ui.hints, silent: true }, root, go); return; }
    if (t.dataset.opt !== undefined && item) {
      const o = item.options[Number(t.dataset.opt)];
      await answer({ outcome: o.correct ? 'correct' : 'wrong', chosenId: o.wordId }, root, go);
    }
  };
}

const NEG = new Set(['wrong', 'revealed', 'self_unknown']);

async function answer(result, root, go) {
  const item = currentItem(S, M.entries);
  const q = S.queue[S.index];
  const before = state(item.wordId)?.status;
  const data = reviewEventData(S, item, result);
  const ev = makeEvent('review', item.wordId, data);
  const evs = [ev];
  // A forgotten mastered word goes back into the learning queue (history kept).
  if (q.maintenance && NEG.has(result.outcome)) evs.push(makeEvent('restore', item.wordId, { reason: 'maintenance_failed' }));
  await addEvents(evs);
  const lenBefore = S.queue.length;
  recordAnswer(S, result);
  const requeued = S.queue.length > lenBefore;
  S.feedback = result.silent ? null : {
    wordId: item.wordId, kind: item.kind, outcome: result.outcome, typo: result.typo, expected: result.expected,
    answer: result.answer, chosenId: result.chosenId, otherId: result.otherId, assisted: result.assisted,
    partnerId: item.partnerId, requeued, itemKey: data.itemKey, eventId: ev.eventId,
    becameAwaiting: before !== 'awaiting_max' && state(item.wordId)?.status === 'awaiting_max',
  };
  await save();
  schedule(3000);
  draw(root, go);
}

function drawEnd(root, go) {
  const words = [...new Set(S.done.map((d) => d.wordId))];
  const right = new Set(S.done.filter((d) => d.outcome === 'correct').map((d) => d.wordId));
  const solid = new Set(S.done.filter((d) => d.outcome === 'correct' && d.recallKind === 'unassisted_recall' && !d.assisted && !d.retry).map((d) => d.wordId));
  const again = new Set(S.done.filter((d) => NEG.has(d.outcome)).map((d) => d.wordId));
  const awaiting = words.filter((id) => state(id)?.status === 'awaiting_max');
  const mastered = words.filter((id) => state(id)?.status === 'mastered');
  setSession(null);
  root.innerHTML = `
    <div class="session end">
      <div class="end-hero"><div class="emoji" aria-hidden="true">🌿</div><h2>Xong rồi, Justin!</h2>
      <p class="muted">${words.length} từ · ${S.done.length} lượt</p></div>
      <div class="card">
        ${right.size ? `<p>✨ Trả lời đúng: <b>${right.size}</b> từ</p>` : ''}
        ${solid.size ? `<p>🧠 Tự nhớ ra, không gợi ý: <b>${solid.size}</b> từ</p>` : ''}
        ${S.mode === 'chill' ? '<p class="small muted">Chill Cards giúp làm quen. Để tính "nhớ chắc", hãy thử Quick Play hoặc Detective.</p>' : ''}
        ${again.size ? `<p>🌱 Sẽ gặp lại sớm: <b>${again.size}</b> từ — bình thường thôi, đó là cách trí nhớ hoạt động.</p>` : ''}
        ${awaiting.length ? `<p>🎤 Sẵn sàng cho Max: ${awaiting.map((id) => `<b>${esc(entry(id)?.fields.term)}</b>`).join(', ')}</p>` : ''}
        ${mastered.length ? `<p>🏆 Đã thuộc: ${mastered.map((id) => `<b>${esc(entry(id)?.fields.term)}</b>`).join(', ')}</p>` : ''}
      </div>
      <div class="s-actions">
        <button class="btn primary big" data-act="home">Về trang chính</button>
        <button class="btn soft" data-act="more">Thêm 2 phút</button>
        ${awaiting.length ? '<a class="btn ghost" href="#/max">Gửi cho Max →</a>' : ''}
      </div>
    </div>`;
  const mode = S.mode;
  root.onclick = (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'home') go('home');
    if (a === 'more') go('session', { minutes: 2, mode });
  };
  root.onsubmit = null;
}
