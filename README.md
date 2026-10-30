# Từ vựng IELTS — Justin's vocabulary PWA

An iPhone-first Progressive Web App for 2–10 minute vocabulary sessions, built on the existing
**"Ielts Words and Phrases"** Google Sheet. The UI is in Vietnamese; vocabulary and practice are in English.

- **Home:** Học 2 / 5 / 10 phút, plus "Tiếp tục" for an interrupted session.
- **Modes:** 🃏 Chill Cards · ⚡ Quick Play (meaning choice, gap-fill in the original sentence, typed recall) · 🔍 IELTS Detective (paraphrase ↔ term, meaning in context, easily confused pairs).
- **Kho từ:** search over every entry, including mastered words in the archive, with full history and "Đưa về học lại" (restore).
- **Speaking with Max:** happens entirely in ChatGPT. The app writes each word's **Trạng thái** (Learning / Review / Mastered) and **Ngày ôn gần nhất** into the Sheet, so Max can read them and pick words to practise.
- **Cài đặt:** connection, real sync status, recall rule, transparent schedule, voice, backup/restore.

## Architecture

```
iPhone (Home Screen PWA)                    Google (your account)
┌────────────────────────────┐   HTTPS POST  ┌──────────────────────────────────────┐
│ static app (GitHub Pages)  │──────────────▶│ Apps Script web app (runs as you)     │
│ IndexedDB: entries, events │◀──────────────│  ├─ "Ielts Words and Phrases" (vocab) │
│ service worker: offline    │  token check  │  │    + additive "ID (app)" column    │
└────────────────────────────┘               │  └─ "IELTS Vocab App – Dữ liệu học"   │
                                             │       Events (append-only), WordState│
                                             └──────────────────────────────────────┘
```

- **Smallest backend:** one Apps Script file bound to the Sheet. It's free, needs no servers and no billing, and holds no API keys. It reads your private Sheet with your own Google authorisation. The app authenticates with a pairing token that you type into the app once; it lives in Script Properties and on your device, never in the code.
- **Vocabulary stays in the Sheet.** The app never rewrites vocabulary content. It adds the `ID (app)` column, fills empty ID cells, and updates only `Trạng thái` and `Ngày ôn gần nhất` (details in [docs/SYNC.md](docs/SYNC.md)).
- **Learning history is separate**, in its own spreadsheet, as the Sheet's "Hướng dẫn" requires ("Kết quả làm đề và lịch học được theo dõi riêng").
- **Offline-first:** every answer is saved to IndexedDB first, queued, and synced later. Events have device-generated UUIDs, so retries and duplicate deliveries are harmless, and state is recomputed by replaying events, so devices can't overwrite each other.

## Learning rules (transparent and configurable)

- **Recall met** = typed correctly **without hints** on **3 different study dates** (configurable 1–6), at least **1** of them contextual (configurable 0–3), and the latest unassisted attempt correct.
  These never count: multiple-choice (recognition), "xem đáp án", Chill Cards self-rating ("Nhớ rồi"), retries within a session, anything with a hint. Several successes on one day count as one date.
- Then the word becomes **Đã thuộc** (mastered): it leaves the active queue and stays searchable in the archive. It is never deleted.
- **Schedule (Leitner boxes):** the first graded attempt of each day decides. Unassisted recall moves the word up a box; recognition, a hint or "lơ mơ" keeps the box; wrong or revealed moves it down a box and schedules it for tomorrow. Intervals: 1 · 2 · 4 · 7 · 15 · 30 · 60 · 120 days.
- **Maintenance** for mastered words after 30 · 90 · 180 days (in 5- and 10-minute sessions). Forgetting one returns it to study automatically, with its history kept.
- No timers, no streaks, no negative scores. Wrong answers get a short explanation and come back later in the session.
- Multiple-choice fairness: distractors never share a meaning with the answer, never come from the same term, and never come from entries whose notes link them as near-synonyms (e.g. *amend / tweak*). Those pairs appear instead as the deliberate "Phân biệt" exercise. If no safe distractors exist, the exercise type isn't offered. "Câu hỏi chưa ổn? Báo lại" voids that answer.
- 🔊 Playback uses the iPhone's own voice and only plays on tap. It is labelled as a model, not as proof of pronunciation; speaking practice and feedback happen with Max in ChatGPT.

## What the app writes into the Sheet (for Max)

| App state | `Trạng thái` | Notes |
|---|---|---|
| never studied | *(unchanged, normally `New`)* | the app never writes `New` |
| studying, not due | `Learning` | |
| due for review | `Review` | |
| recall criteria met | `Mastered` | |

`Ngày ôn gần nhất` = the last study date (it only moves forward). Writes happen only when the app's status for a word **changes**, so if Max or another chat edits a status, the app leaves it alone until it has news. It never replaces a `Mastered` that someone else set. A row in "Hướng dẫn" explains this to other chats. To turn it off, set Script Property `SHEET_WRITEBACK` to `off`.

---

## Setup (one time, about 10 minutes, on a computer)

### 1. Install the backend in your Sheet
1. Open the Sheet → **Extensions → Apps Script**.
2. Delete the contents of `Code.gs` and paste [backend/Code.gs](backend/Code.gs).
3. ⚙️ **Project Settings** → tick **"Show 'appsscript.json' manifest file in editor"** → open `appsscript.json` and replace it with [backend/appsscript.json](backend/appsscript.json). Save.
4. In the function dropdown choose **`setup`** → **Run** → **Review permissions** → choose your account. Google will say *"Google hasn't verified this app"* because it's your own script: **Advanced → Go to … (unsafe) → Allow**.
   `setup` will:
   - add the column **`ID (app)`** after "Ghi chú / Lỗi dễ nhầm" and fill IDs for existing rows (no other cell changes),
   - add two explanatory rows to "Hướng dẫn" ("Cột ID (app)", "App cập nhật trạng thái"), so other chats and Max know what the app does,
   - create the spreadsheet **"IELTS Vocab App – Dữ liệu học (đừng sửa tay)"** in your Drive,
   - generate the **pairing token**.
5. Open **Execution log** and copy the **token** (also available any time: Sheet menu **IELTS App → Hiện mã kết nối**).
6. **Deploy → New deployment** → ⚙️ type **Web app** → *Execute as:* **Me** → *Who has access:* **Anyone** → **Deploy**. Copy the **Web app URL** (ends in `/exec`).
   *"Anyone" is needed because an iPhone web app can't send Google login cookies to Apps Script. Every request still needs the token, and without it the script returns `unauthorized` and no data.*
7. Updating the backend later: paste the new code → **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

Optional: `installWeeklyBackup` (run once) makes a weekly copy of the data spreadsheet. `rotateToken` issues a new token if the old one leaks.

### 2. Host the app (free HTTPS)
The repository includes [.github/workflows/pages.yml](.github/workflows/pages.yml), which tests the app, stamps the cache version and publishes `app/` to GitHub Pages:

```bash
git init -b main
```
```bash
git add . && git commit -m "IELTS vocab PWA"
```
```bash
gh repo create ielts-vocab-pwa --public --source . --push
```
Then on GitHub: **Settings → Pages → Source: GitHub Actions**. The URL will be `https://<your-username>.github.io/ielts-vocab-pwa/`.
(The code contains no vocabulary, token or URL of yours. A free account needs a public repo for Pages; any static HTTPS host such as Cloudflare Pages or Netlify works too.)

### 3. Install on iPhone (Safari)
1. Open the app URL in **Safari**.
2. Tap **Share** (□↑). On newer iOS, tap **•••** first, then **Share**. Choose **Add to Home Screen**, keep **Open as Web App** on, then **Add**.
3. Open **Từ vựng** from the Home Screen. ⚠️ The Home Screen app has **its own storage**, separate from the Safari tab, so connect from inside the installed app.
4. Choose **Kết nối Google Sheet của mình** → paste the **Web app URL** and **token** → **Kiểm tra & lưu**. The badge should read **"Đã lưu lên Google · hh:mm"**.

Offline: after the first open, the app launches without a network. Answers are queued ("N thay đổi chỉ trên máy") and sent when you're back online.
Updates: when a new version is deployed, a banner **"Có phiên bản mới — Tải lại"** appears.

### Without Google access
- **DEMO:** sample words written for the demo, clearly labelled and never synced.
- **File CSV:** on a computer, Sheet → File → Download → CSV (tab *Vocab & Phrases*) → Cài đặt → *Nhập file CSV*. Local-only, never synced, with local IDs (not the Sheet's IDs).

Each mode has its own on-device database. Switching never mixes or deletes data.

## Backup & restore
Cài đặt → **Xuất bản sao lưu (.json)** (Share sheet → Save to Files). **Khôi phục từ file** previews counts, then **merges** by event ID: it adds what's missing, deletes nothing, and creates no duplicates on the server.

## Development
```bash
npm test
```
```bash
npm run dev
```
`npm run dev` serves the app at http://localhost:8787 and runs the **real `backend/Code.gs`** on an in-memory emulation of Sheets ([tools/gas-mock.mjs](tools/gas-mock.mjs)), with test controls for going offline and simulating rows added by other chats (see [tools/dev-server.mjs](tools/dev-server.mjs)). Before deploying by hand, run `node tools/stamp-sw.mjs` so iPhones receive the update. `node tools/make-icons.mjs` regenerates the icons.

```
app/            the PWA (index.html, manifest, sw.js, css/, icons/, js/core = pure logic, js/ui = screens)
backend/        Apps Script (Code.gs, appsscript.json)
docs/SYNC.md    sync & ID contract
tests/          node --test: core logic + backend against the Sheets emulation
tools/          dev server, Apps Script emulation, icon generator, cache-version stamp
```
