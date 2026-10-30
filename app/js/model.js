// App data model: loads the active mode's data, appends events, derives word states.
import { openModeDb, openGlobalDb, requestPersistence } from './store.js';
import { computeStates, DEFAULT_CONFIG, stateSnapshot } from './core/state.js';
import { studyDate } from './core/dates.js';
import { DEMO_ENTRIES } from './demo-data.js';

export const APP_VERSION = '1.0.0';

const listeners = new Set();
export const M = {
  mode: null,            // 'live' | 'demo' | 'file' | null (not chosen)
  db: null,
  gdb: null,
  deviceId: null,
  entries: [],
  events: [],
  states: new Map(),
  flags: new Set(),
  config: { ...DEFAULT_CONFIG },
  settings: { voiceURI: '', rate: 0.9, preferredMode: 'quick' },
  conn: { url: '', token: '' },
  maxExports: [],
  persisted: false,
};

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what) { for (const fn of listeners) fn(what); }

export function today() { return studyDate(new Date(), M.config.timezone); }

export async function boot() {
  M.gdb = await openGlobalDb();
  M.deviceId = await M.gdb.getKv('deviceId');
  if (!M.deviceId) { M.deviceId = 'd-' + crypto.randomUUID().slice(0, 13); await M.gdb.setKv('deviceId', M.deviceId); }
  const mode = await M.gdb.getKv('mode');
  M.persisted = await requestPersistence();
  if (mode) await switchMode(mode, { silent: true });
}

export async function switchMode(mode, { silent } = {}) {
  if (M.db) M.db.close();
  M.mode = mode;
  await M.gdb.setKv('mode', mode);
  M.db = await openModeDb(mode);
  if (mode === 'demo' && !(await M.db.getKv('seeded'))) {
    await M.db.putMany('entries', DEMO_ENTRIES);
    await M.db.setKv('seeded', true);
  }
  await reload();
  if (!silent) emit('mode');
}

export async function reload() {
  M.entries = (await M.db.getAll('entries')).sort((a, b) => (a.row || 0) - (b.row || 0) || a.id.localeCompare(b.id));
  M.events = await M.db.getAll('events');
  M.config = { ...DEFAULT_CONFIG, ...(await M.db.getKv('config', {})) };
  M.settings = { ...M.settings, ...(await M.db.getKv('settings', {})) };
  M.conn = { url: '', token: '', ...(await M.db.getKv('conn', {})) };
  M.maxExports = await M.db.getKv('maxExports', []);
  recompute();
}

export function recompute() {
  const { states, flags } = computeStates(M.entries, M.events, M.config, today());
  M.states = states;
  M.flags = flags;
}

export function entry(id) { return M.entries.find((e) => e.id === id) || null; }
export function state(id) { return M.states.get(id) || null; }

export function makeEvent(type, wordId, data = {}) {
  return {
    eventId: crypto.randomUUID(), v: 1, type, wordId,
    ts: new Date().toISOString(), studyDate: today(), deviceId: M.deviceId,
    data, _synced: 0,
  };
}

// Persist first, then update memory: an event that is on screen is always on disk.
export async function addEvents(evs) {
  if (!evs.length) return;
  await M.db.putMany('events', evs);
  M.events.push(...evs);
  recompute();
  await checkMastery();
  emit('events');
}

export async function checkMastery() {
  const extra = masteryEvents();
  if (!extra.length) return 0;
  await M.db.putMany('events', extra);
  M.events.push(...extra);
  recompute();
  return extra.length;
}

export function addEvent(type, wordId, data) { const e = makeEvent(type, wordId, data); return addEvents([e]).then(() => e); }

// A word becomes Mastered (and leaves the active queue) only when recall criteria are
// met AND Max confirmed pronunciation AND usage. Recorded as an explicit event.
function masteryEvents() {
  const out = [];
  for (const s of M.states.values()) {
    if (s.eligibleForMastery && s.inSheet) out.push(makeEvent('mastered', s.id, { reason: 'recall+max_pronunciation+max_usage' }));
  }
  return out;
}

export async function saveConfig(cfg) { M.config = { ...M.config, ...cfg }; await M.db.setKv('config', pick(M.config, ['requiredDates', 'requiredContextual'])); recompute(); emit('config'); }
export async function saveSettings(s) { M.settings = { ...M.settings, ...s }; await M.db.setKv('settings', M.settings); emit('settings'); }
export async function saveConn(c) { M.conn = { ...M.conn, ...c }; await M.db.setKv('conn', M.conn); emit('conn'); }
export async function saveMaxExports(list) { M.maxExports = list; await M.db.setKv('maxExports', list); }

function pick(o, keys) { return Object.fromEntries(keys.map((k) => [k, o[k]])); }

export async function getSession() { return M.db ? M.db.getKv('session') : null; }
export async function setSession(s) { await M.db.setKv('session', s); }

export function counts() {
  const c = { new: 0, learning: 0, review: 0, awaiting_max: 0, mastered: 0, removed: 0, due: 0 };
  for (const s of M.states.values()) {
    c[s.status] = (c[s.status] || 0) + 1;
    if (s.due && s.status !== 'new' && !s.archived && s.inSheet) c.due++;
  }
  return c;
}

export function snapshots() {
  return M.entries.map((e) => stateSnapshot(M.states.get(e.id), e)).filter(Boolean);
}
