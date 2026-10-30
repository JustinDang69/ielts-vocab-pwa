# Sync contract

Two kinds of data, two owners:

| Data | Owner | Where it lives |
|---|---|---|
| Vocabulary content (term, meaning, context, …) | **The Sheet** ("Vocab & Phrases"); other ChatGPT chats keep editing it | Google Sheet. The app only reads it, except for the `ID (app)` column |
| Learning history (reviews, hints, errors, Max results, mastery, restores) | **The app** | Append-only event log: IndexedDB on the device + `Events` tab of the separate "IELTS Vocab App – Dữ liệu học" spreadsheet |

Derived state (box, next review date, recall progress, status) is **never synced as truth**. Every device computes it by replaying the event log (`app/js/core/state.js`). The server keeps a readable mirror (`WordState` tab) for humans and backups.

## Stable IDs

- Column `ID (app)` is appended after the last column of "Vocab & Phrases" (additive; no existing column is moved, renamed or rewritten). A cell note and a row in "Hướng dẫn" tell other chats to leave it empty for new rows and never copy it.
- On every sync, `assignIds_()` (under a script lock) gives each row that has a term but no ID a new `v-xxxxxxxx` ID. Before writing, it re-reads that row; if the term or ID changed meanwhile, it skips the row until the next sync.
- If the same ID appears on several rows (a copied row), the **first** row keeps it and later rows get new IDs. Each reassignment is logged in the data spreadsheet's `Log` tab.
- Duplicate terms with different meanings are separate rows, so they get separate IDs, as the Sheet's own rules require.
- Row numbers are returned for display only and are never used as identity.
- A row that disappears from the Sheet stays in the app as "Không còn trong Sheet" with its history. If the server ever returns 0 rows, nothing is marked removed (protection against a renamed tab).

## Events

```json
{ "eventId": "uuid", "v": 1, "type": "review|max_result|max_export|mastered|restore|flag_item",
  "wordId": "v-1a2b3c4d", "ts": "ISO-8601", "studyDate": "YYYY-MM-DD (Australia/Sydney)",
  "deviceId": "d-…", "data": { … } }
```

- An event is written to IndexedDB **before** it is shown as done, then queued (`_synced: 0`).
- `eventId` is generated on the device, so retries are idempotent: the server skips IDs it already has and reports them as `duplicates`. The client treats `accepted ∪ duplicates` as saved.
- The server validates each event (ID format, type, date, size). For `max_result` it also checks that the word exists, the outcome values are valid, and `pronunciation ≠ "not_assessed"` comes with `pronunciationEvidence = "audio"`. Rejected events stay on the device with the reason shown in Cài đặt → Đồng bộ.
- The server assigns an increasing `seq`. Clients pull `seq > lastSeq` to receive other devices' events (≤1000 per call, `more: true` to continue).
- Ordering for replay is `(ts, eventId)`, which is deterministic on every device. Conflicts can't happen because nothing is overwritten: two devices reviewing the same word offline simply contribute two events.
- A `flag_item` ("câu hỏi chưa ổn") voids the review it was raised on and stops that exercise type for that word.

## API (Apps Script web app, `POST`, body is JSON sent as `text/plain`)

Every request includes `token` (the pairing secret from Script Properties) and `deviceId`.

| action | request | response |
|---|---|---|
| `ping` | – | `{ok, apiVersion, serverTime}` |
| `sync` | `events[] (≤500)`, `sinceSeq` | `{ids:{assigned,reassigned,skipped}, vocab:{entries[], warnings[], pendingIds, statusOptions[]}, push:{accepted[], duplicates[], rejected[{eventId,reason}]}, pull:{events[], lastSeq, more}}` |
| `pushState` | `states[]` with `computedFromSeq` | `{updated, stale, writeback}`. A mirror row is only replaced by a snapshot computed from ≥ as many server events |

Errors: `{ok:false, error:"unauthorized"|"bad_json"|"unknown_action"|"server_error", message?}`.

## Client sync loop (`app/js/sync.js`)

1. Runs after answers (debounced about 3 s), on app open, on `online` and `visibilitychange`, and on demand ("Đồng bộ ngay").
2. Push up to 400 pending events, pull new server events, repeat while there is more.
3. Merge vocabulary: the Sheet wins for content. Entries are upserted by ID, and entries missing from the Sheet are flagged, never deleted.
4. Recompute states, emit any `mastered` events that are now due, and push the `WordState` mirror (only when nothing is pending).
5. On failure: exponential backoff (5 s → 10 min). A wrong token stops retries until it's fixed.

The badge says **"Đã lưu lên Google · time"** only when the device has no pending events and the last sync succeeded. Otherwise it says **"N thay đổi chỉ trên máy"**.

## Optional Sheet write-back (off by default)

Script Properties `WRITEBACK_STATUS` / `WRITEBACK_LAST_REVIEW` = `true` enable writing `Trạng thái` (`New/Learning/Review/Mastered` only, taken from the existing dropdown; never overwrites a `Mastered` cell; "Chờ Max kiểm tra" is shown as `Learning`) and `Ngày ôn gần nhất` (only moves forward). Writes are single cells on the row whose `ID (app)` matches, re-checked just before writing.

## Backups

- Device: Cài đặt → "Xuất bản sao lưu (.json)" (entries + full event log + settings). Restore is a merge by `eventId`, so restoring never deletes anything and never creates duplicates on the server.
- Server: the data spreadsheet is append-only and has Google's version history. `backupNow()` copies it, and `installWeeklyBackup()` adds a weekly copy trigger (optional).
