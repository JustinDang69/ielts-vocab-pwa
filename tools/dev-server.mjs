// Local test harness: serves the PWA and runs the real backend/Code.gs on top of the
// in-memory Apps Script emulation at POST /exec. Not for production.
//   node tools/dev-server.mjs [--port 8787] [--csv path/to/vocab.csv]
// Dev controls (for testing offline/reconnect and "another chat added a row"):
//   POST /dev/offline?on=1|0   make everything except /dev/* unreachable (connection reset), or reachable again
//   POST /dev/add-row          JSON body {term, meaning, context, ...} appended without an ID
//   POST /dev/speaking-row     JSON body {"ID (app)": ..., "Cách dùng": ...} appended to "Speaking Results", as a chatbot would
//   GET  /dev/dump             current vocab tab, Speaking Results, Events and WordState tables
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGas } from './gas-mock.mjs';
import { parseCSV } from '../app/js/core/csv.js';
import { HEADERS } from '../app/js/core/fields.js';
import { DEMO_ENTRIES } from '../app/js/demo-data.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []));
const PORT = Number(args.port || process.env.PORT || 8787);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const HEAD = Object.entries(HEADERS).filter(([k]) => k !== 'id').map(([, v]) => v);

let rows;
if (args.csv) rows = parseCSV(fs.readFileSync(args.csv, 'utf8')).filter((r) => r.some(Boolean));
else rows = [HEAD, ...DEMO_ENTRIES.map((e) => Object.keys(HEADERS).filter((k) => k !== 'id').map((k) => (k === 'source' ? 'local test fixture' : e.fields[k])))];
const gas = createGas({ vocabRows: rows });
if (process.env.DEV_TOKEN) gas.props.set('API_TOKEN', process.env.DEV_TOKEN);
gas.ctx.setup();
let offline = false;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const body = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => res(b)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // "offline" = the whole server is unreachable (app shell must come from the service worker)
  if (offline && !url.pathname.startsWith('/dev/')) { req.socket.destroy(); return; }
  if (url.pathname === '/exec' && req.method === 'POST') {
    const b = await body(req);
    await new Promise((r) => setTimeout(r, 250)); // Apps Script is not instant
    const out = gas.ctx.doPost({ postData: { contents: b } }).getContent();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(out);
  }
  if (url.pathname === '/dev/offline') { offline = url.searchParams.get('on') === '1'; res.end(JSON.stringify({ offline })); return; }
  if (url.pathname === '/dev/add-row' && req.method === 'POST') {
    const f = JSON.parse((await body(req)) || '{}');
    const idx = gas.vocab.getRange(1, 1, 1, gas.vocab.getLastColumn()).getDisplayValues()[0];
    gas.vocab.appendRow(idx.map((h) => { const k = Object.keys(HEADERS).find((x) => HEADERS[x] === h); return k && k !== 'id' ? (f[k] ?? '') : ''; }));
    res.end(JSON.stringify({ ok: true, lastRow: gas.vocab.getLastRow() }));
    return;
  }
  if (url.pathname === '/dev/speaking-row' && req.method === 'POST') {
    const f = JSON.parse((await body(req)) || '{}');
    const tab = gas.bound.getSheetByName('Speaking Results');
    if (!tab) { res.writeHead(409); res.end('Speaking Results tab not created yet (sync once first)'); return; }
    const head = tab.getRange(1, 1, 1, tab.getLastColumn()).getDisplayValues()[0];
    tab.appendRow(head.map((h) => f[h] ?? ''));
    res.end(JSON.stringify({ ok: true, row: tab.getLastRow() }));
    return;
  }
  if (url.pathname === '/dev/dump') {
    const d = gas.data();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ vocab: gas.vocab.table(), speaking: gas.bound.getSheetByName('Speaking Results')?.table() || [], events: d.getSheetByName('Events').table(), wordState: d.getSheetByName('WordState').table(), log: d.getSheetByName('Log').table() }, null, 1));
    return;
  }
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`IELTS Vocab dev server: http://localhost:${PORT}/`);
  console.log(`Backend URL (paste in app): http://localhost:${PORT}/exec`);
  console.log(`Token: ${gas.token()}`);
});
