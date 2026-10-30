import { M, boot, onChange } from './model.js';
import { initSync, schedule } from './sync.js';
import { speak } from './tts.js';
import { $, toast } from './ui/dom.js';
import { syncBadge } from './ui/common.js';
import { renderHome } from './ui/home.js';
import { renderSession } from './ui/session-view.js';
import { renderLibrary, renderWord } from './ui/library.js';
import { renderMax } from './ui/max-view.js';
import { renderSettings, renderWelcome } from './ui/settings.js';

const NAV = [
  ['home', '#/', '🏠', 'Học'],
  ['library', '#/library', '📚', 'Kho từ'],
  ['max', '#/max', '🎤', 'Max'],
  ['settings', '#/settings', '⚙️', 'Cài đặt'],
];

let sessionParams = null;

function parse() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const [name, arg] = path.split('/');
  return { name: name || 'home', arg: arg ? decodeURIComponent(arg) : null, params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export function go(name, params) {
  if (name === 'session') { sessionParams = params; location.hash = '#/session'; if (parse().name === 'session') route(); return; }
  location.hash = name === 'home' ? '#/' : '#/' + name;
}

async function route() {
  const { name, arg, params } = parse();
  const view = $('#view');
  const inSession = name === 'session';
  document.body.classList.toggle('in-session', inSession);
  if (!M.mode && name !== 'welcome') { location.hash = '#/welcome'; return; }
  drawChrome(name);
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  if (name === 'welcome') return renderWelcome(view, go);
  if (name === 'session') {
    const p = sessionParams || { resume: true };
    sessionParams = null;
    return renderSession(view, p, go);
  }
  if (name === 'library') return renderLibrary(view, params);
  if (name === 'word') return renderWord(view, arg, go);
  if (name === 'max') return renderMax(view);
  if (name === 'settings') return renderSettings(view, go);
  return renderHome(view, go);
}

function drawChrome(active) {
  $('#badge').innerHTML = M.mode ? syncBadge() : '';
  $('#nav').innerHTML = NAV.map(([k, href, icon, label]) => `<a href="${href}" class="${k === active ? 'on' : ''}" ${k === active ? 'aria-current="page"' : ''}><span aria-hidden="true">${icon}</span>${label}</a>`).join('');
}

onChange((what) => {
  if (what === 'sync' || what === 'events') $('#badge').innerHTML = M.mode ? syncBadge() : '';
  if (what === 'mode') route();
});

// Pronunciation buttons anywhere (tap only — never autoplay).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-speak]');
  if (b) { e.preventDefault(); if (!speak(b.dataset.speak, M.settings)) toast('Thiết bị không hỗ trợ đọc mẫu.'); }
});

window.addEventListener('hashchange', route);

async function start() {
  try {
    await boot();
  } catch (e) {
    $('#view').innerHTML = `<div class="card"><h3>Không mở được bộ nhớ trên máy</h3><p class="small">${e.message}</p><p class="small">Nếu đang dùng chế độ duyệt riêng tư, hãy mở bằng Safari thường hoặc từ Màn hình chính.</p></div>`;
    return;
  }
  await initSync();
  route();
  if (M.mode === 'live') schedule(800);
  registerSW();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
      });
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

function showUpdate(worker) {
  const el = document.createElement('div');
  el.className = 'update';
  el.innerHTML = 'Có phiên bản mới. <button class="btn small primary">Tải lại</button>';
  el.querySelector('button').onclick = () => worker.postMessage('skipWaiting');
  document.body.append(el);
}

start();
