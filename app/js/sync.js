// Sync with the Apps Script backend (live mode only). See docs/SYNC.md for the contract.
// Truthfulness rule: the UI only says "đã lưu lên Google" for events the server acknowledged.
import { M, emit, recompute, snapshots, checkMastery } from './model.js';

export const S = {
  state: 'idle',        // idle | syncing | offline | error | unconfigured | not_live
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: '',
  failures: 0,
  log: [],
  vocabWarnings: [],
};

const BACKOFF = [5, 20, 60, 180, 600];
let timer = null;
let running = null;

export function pending() { return M.events.filter((e) => !e._synced && !e._rejected); }
export function rejected() { return M.events.filter((e) => e._rejected); }

export async function initSync() {
  S.lastSuccessAt = M.db ? await M.db.getKv('lastSyncAt') : null;
  refreshState();
  window.addEventListener('online', () => schedule(500));
  window.addEventListener('offline', () => { refreshState(); emit('sync'); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(800); });
}

export function refreshState() {
  if (M.mode !== 'live') S.state = 'not_live';
  else if (!M.conn.url || !M.conn.token) S.state = 'unconfigured';
  else if (!navigator.onLine) S.state = 'offline';
  else if (S.state === 'not_live' || S.state === 'unconfigured' || S.state === 'offline') S.state = 'idle';
}

export function schedule(ms = 4000) {
  refreshState();
  if (S.state === 'not_live' || S.state === 'unconfigured') { emit('sync'); return; }
  clearTimeout(timer);
  timer = setTimeout(() => syncNow('auto'), ms);
}

export async function call(body, { url = M.conn.url, token = M.conn.token, timeout = 45000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      // text/plain avoids a CORS preflight, which Apps Script cannot answer
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, token, deviceId: M.deviceId }),
      redirect: 'follow', cache: 'no-store', signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Hết thời gian chờ máy chủ' : 'Không kết nối được máy chủ (mạng hoặc URL)');
  } finally { clearTimeout(t); }
  if (!r.ok) throw new Error('Máy chủ trả lỗi HTTP ' + r.status);
  let j;
  try { j = await r.json(); } catch (e) {
    throw new Error('Phản hồi không phải JSON — kiểm tra bản triển khai Apps Script (quyền truy cập "Anyone").');
  }
  if (!j.ok) {
    const msg = { unauthorized: 'Sai mã kết nối (token)', unknown_action: 'Phiên bản backend không khớp', server_error: 'Lỗi máy chủ: ' + (j.message || '') }[j.error] || j.error;
    const err = new Error(msg); err.code = j.error; throw err;
  }
  return j;
}

export function syncNow(reason = 'manual') {
  if (running) return running;
  running = doSync(reason).finally(() => { running = null; });
  return running;
}

async function doSync(reason) {
  refreshState();
  if (S.state === 'not_live' || S.state === 'unconfigured') { emit('sync'); return false; }
  if (!navigator.onLine) { S.state = 'offline'; emit('sync'); return false; }
  S.state = 'syncing'; S.lastAttemptAt = new Date().toISOString(); emit('sync');
  try {
    let rounds = 0, more = true;
    let vocab = null;
    while (more && rounds < 8) {
      rounds++;
      const batch = pending().sort((a, b) => (a.ts < b.ts ? -1 : 1)).slice(0, 400);
      const sinceSeq = (await M.db.getKv('lastSeq')) || 0;
      const res = await call({ action: 'sync', sinceSeq, events: batch.map(clean) });
      await applyPush(batch, res.push);
      await applyPull(res.pull);
      vocab = res.vocab;
      more = res.pull.more || pending().length > 0 && batch.length === 400;
    }
    if (vocab) await mergeVocab(vocab);
    recompute();
    await checkMastery();
    await pushStateIfClean();
    S.lastSuccessAt = new Date().toISOString();
    await M.db.setKv('lastSyncAt', S.lastSuccessAt);
    S.state = 'idle'; S.lastError = ''; S.failures = 0;
    addLog(`OK (${reason})`);
    emit('events');
    emit('sync');
    if (pending().length) schedule(1500); // mastery events created during merge
    return true;
  } catch (e) {
    S.failures++;
    S.lastError = e.message;
    S.state = navigator.onLine ? 'error' : 'offline';
    addLog('Lỗi: ' + e.message);
    emit('sync');
    if (e.code !== 'unauthorized') {
      clearTimeout(timer);
      timer = setTimeout(() => syncNow('retry'), BACKOFF[Math.min(S.failures - 1, BACKOFF.length - 1)] * 1000);
    }
    return false;
  }
}

function clean(e) {
  const { _synced, _rejected, seq, ...rest } = e;
  return rest;
}

async function applyPush(batch, push) {
  const ok = new Set([...(push.accepted || []), ...(push.duplicates || [])]);
  const bad = new Map((push.rejected || []).map((r) => [r.eventId, r.reason]));
  const changed = [];
  for (const e of batch) {
    if (ok.has(e.eventId)) { e._synced = 1; changed.push(e); } else if (bad.has(e.eventId)) { e._rejected = bad.get(e.eventId); changed.push(e); }
  }
  if (changed.length) await M.db.putMany('events', changed);
}

async function applyPull(pull) {
  const have = new Map(M.events.map((e) => [e.eventId, e]));
  const put = [];
  for (const ev of pull.events || []) {
    const local = have.get(ev.eventId);
    if (local) {
      if (!local._synced || local.seq !== ev.seq) { local._synced = 1; local.seq = ev.seq; put.push(local); }
    } else {
      const e = { ...ev, _synced: 1 };
      M.events.push(e); have.set(e.eventId, e); put.push(e);
    }
  }
  if (put.length) await M.db.putMany('events', put);
  await M.db.setKv('lastSeq', pull.lastSeq || 0);
}

// The Sheet is the authority for vocabulary content. Entries missing from the Sheet are
// kept (with their history) and marked inSheet=false — never deleted.
async function mergeVocab(vocab) {
  S.vocabWarnings = [...(vocab.warnings || [])];
  if (vocab.pendingIds) S.vocabWarnings.push(`${vocab.pendingIds} hàng mới chưa có ID (sẽ gán ở lần sau).`);
  const server = new Map(vocab.entries.map((e) => [e.id, e]));
  if (!server.size && M.entries.length) {
    S.vocabWarnings.push('Máy chủ trả về 0 từ — giữ nguyên dữ liệu trên máy (kiểm tra tên tab "Vocab & Phrases").');
    return;
  }
  const now = new Date().toISOString();
  const out = [];
  for (const [id, e] of server) out.push({ id, row: e.row, fields: e.fields, inSheet: true, lastSeenAt: now });
  for (const e of M.entries) if (!server.has(e.id) && e.inSheet !== false) out.push({ ...e, inSheet: false });
  await M.db.putMany('entries', out);
  const map = new Map(M.entries.map((e) => [e.id, e]));
  for (const e of out) map.set(e.id, e);
  M.entries = [...map.values()].sort((a, b) => (a.row || 1e9) - (b.row || 1e9));
  await M.db.setKv('statusOptions', vocab.statusOptions || []);
}

async function pushStateIfClean() {
  if (pending().length) return;
  const lastSeq = (await M.db.getKv('lastSeq')) || 0;
  const sent = (await M.db.getKv('stateHashes')) || {};
  const changed = [];
  for (const s of snapshots()) {
    const h = JSON.stringify(s);
    if (sent[s.wordId] !== h) changed.push({ s, h });
  }
  if (!changed.length) return;
  await call({ action: 'pushState', states: changed.map(({ s }) => ({ ...s, computedFromSeq: lastSeq })) });
  for (const { s, h } of changed) sent[s.wordId] = h;
  await M.db.setKv('stateHashes', sent);
}

function addLog(msg) {
  S.log.unshift({ at: new Date().toISOString(), msg });
  S.log = S.log.slice(0, 15);
}
