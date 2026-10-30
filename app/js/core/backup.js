// Device backup file. Restore is a non-destructive merge: events are unioned by eventId,
// entries by id (the newer copy of an entry wins). Nothing on the device is deleted.
export const BACKUP_FORMAT = 'ielts-vocab-backup/v1';

export function makeBackup({ mode, deviceId, entries, events, settings, exports, appVersion }) {
  return {
    format: BACKUP_FORMAT,
    appVersion,
    exportedAt: new Date().toISOString(),
    mode,
    deviceId,
    counts: { entries: entries.length, events: events.length },
    settings,
    maxExports: exports || [],
    entries,
    events: events.map(({ _synced, _rejected, ...e }) => ({ ...e, synced: !!_synced })),
  };
}

export function validateBackup(obj) {
  const errors = [];
  if (!obj || obj.format !== BACKUP_FORMAT) errors.push(`Không phải file sao lưu (${BACKUP_FORMAT}).`);
  if (!Array.isArray(obj?.entries)) errors.push('Thiếu danh sách "entries".');
  if (!Array.isArray(obj?.events)) errors.push('Thiếu danh sách "events".');
  const badEv = (obj?.events || []).filter((e) => !e || typeof e.eventId !== 'string' || typeof e.type !== 'string' || typeof e.ts !== 'string');
  if (badEv.length) errors.push(`${badEv.length} sự kiện thiếu eventId/type/ts.`);
  const badEn = (obj?.entries || []).filter((e) => !e || typeof e.id !== 'string' || !e.fields);
  if (badEn.length) errors.push(`${badEn.length} mục từ thiếu id/fields.`);
  return errors;
}

export function planMerge(backup, current) {
  const haveEv = new Set(current.events.map((e) => e.eventId));
  const haveEn = new Map(current.entries.map((e) => [e.id, e]));
  const newEvents = backup.events.filter((e) => !haveEv.has(e.eventId));
  const newEntries = backup.entries.filter((e) => !haveEn.has(e.id));
  return { newEvents, newEntries, skippedEvents: backup.events.length - newEvents.length, modeMismatch: backup.mode !== current.mode };
}
