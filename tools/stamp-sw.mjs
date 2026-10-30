// Sets the service-worker cache VERSION to a hash of the app shell and checks that every
// file in app/ is precached. Run before every deploy: node tools/stamp-sw.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const swPath = path.join(APP, 'sw.js');
let sw = fs.readFileSync(swPath, 'utf8');
const shell = JSON.parse('[' + sw.match(/const SHELL = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(d, f.name)) : [path.join(d, f.name)]));
const files = walk(APP).map((f) => path.relative(APP, f).split(path.sep).join('/')).filter((f) => f !== 'sw.js');
const missing = files.filter((f) => !shell.includes(f));
const extra = shell.filter((f) => f !== './' && !files.includes(f));
if (missing.length || extra.length) {
  console.error('SHELL list out of date.', { missing, extra });
  process.exit(1);
}
const h = crypto.createHash('sha256');
for (const f of files.sort()) h.update(f).update(fs.readFileSync(path.join(APP, f)));
const appVersion = fs.readFileSync(path.join(APP, 'js/model.js'), 'utf8').match(/APP_VERSION = '([^']+)'/)[1];
const version = `v${appVersion}-${h.digest('hex').slice(0, 10)}`;
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
fs.writeFileSync(swPath, sw);
console.log('sw.js VERSION =', version);
