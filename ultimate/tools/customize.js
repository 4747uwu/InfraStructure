#!/usr/bin/env node
// tools/customize.js — turn this tree (the Ganesham Teleradiology router) into the
// router for another client, from one JSON spec. Used by Router Hub's builder.
//
//   node tools/customize.js spec.json
//
// It is tools/variant.js generalised: the same idea (rewrite the handful of
// values that make a router a distinct product), driven by data instead of two
// hard-coded variants, and extended to the values that differ per client: the
// receivers, the backend API hosts, the defaults an operator starts with, and the
// artwork.
//
// STRICT BY DESIGN. Every replacement names the exact text it expects to find in
// the Ganesham tree and how many times. If the template ever changes so an anchor
// is missing or appears a different number of times, this stops with the file and
// the anchor rather than shipping a router that is half one client, half another
// (say, a new name on a binary that still reports to Ganesham's PACS).
//
// Run it on a FRESH copy of the template, once.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---- the template's own values (what every anchor below looks for) ----------

const FROM = {
  productName: 'Ganesham Teleradiology',
  first: 'Ganesham',
  tail: ' Teleradiology',
  aet: 'GANESHAM',
  dicomPort: 8899,
  httpPort: 9044,
  senderExe: 'ganesham-sender',
  peer1: 'https://router.ganeshamteleradiology.in',
  peer2: 'https://ganeshamteleradiologyrouter.xcentic.com',
  apiMain: 'https://pacs.ganeshamteleradiology.in',
  apiBackup: 'https://ganeshamteleradiology.xcentic.com',
  apiHosts: "['pacs.ganeshamteleradiology.in', 'ganeshamteleradiology.xcentic.com']",
  peerUser: 'Xcentic',
  peerPass: 'XcenticIngestion123',
  pin: '18967',
};

// ---- spec ------------------------------------------------------------------

function fail(msg) {
  console.error(`customize: ${msg}`);
  process.exit(1);
}

const specPath = process.argv[2];
if (!specPath) fail('usage: node tools/customize.js spec.json');
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

// The hub validates too; this is the last line before values land in source code.
function origin(url, label) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    fail(`${label} is not a URL: ${url}`);
  }
  if (!/^https?:$/.test(u.protocol)) fail(`${label} must start with http:// or https://`);
  if (u.username || u.password) fail(`${label} must not contain a login`);
  return `${u.protocol}//${u.host}`; // scheme + host[:port], nothing else
}
const int = (v, label, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};
const safeText = (v, label, re, max) => {
  const s = String(v ?? '').trim();
  if (!s || s.length > max || !re.test(s)) fail(`${label} has characters that are not allowed: ${JSON.stringify(s)}`);
  return s;
};

const productName = safeText(spec.productName, 'productName', /^[A-Za-z0-9][A-Za-z0-9 .&()'-]*$/, 60);
const words = productName.split(/\s+/);
const first = words[0];
const tail = words.length > 1 ? ` ${words.slice(1).join(' ')}` : '';
const slug = productName.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
if (!slug) fail('productName must contain letters or digits');

const T = {
  productName,
  first,
  tail,
  pkgName: spec.pkgName || slug,
  appId: spec.appId || `com.routerhub.${slug.replace(/-/g, '')}`,
  senderExe: spec.senderExe || `${slug}-sender`,
  aet: safeText(spec.aet, 'aet', /^[A-Z0-9_]{1,16}$/, 16),
  dicomPort: int(spec.dicomPort, 'dicomPort', 1, 65535),
  httpPort: int(spec.httpPort, 'httpPort', 1024, 65535),
  peer1: origin(spec.peer1, 'peer1'),
  peer2: spec.peer2 ? origin(spec.peer2, 'peer2') : null,
  apiMain: origin(spec.apiMain, 'apiMain'),
  apiBackup: spec.apiBackup ? origin(spec.apiBackup, 'apiBackup') : null,
  compression: Boolean(spec.compression),
  peerUser: safeText(spec.peerUsername ?? FROM.peerUser, 'peerUsername', /^[\w.@-]+$/, 80),
  peerPass: safeText(spec.peerPassword ?? FROM.peerPass, 'peerPassword', /^[\x21-\x7e]+$/, 120),
  pin: safeText(spec.settingsPin ?? FROM.pin, 'settingsPin', /^[0-9]{4,12}$/, 12),
  version: safeText(spec.version ?? '0.1.0', 'version', /^\d+\.\d+\.\d+$/, 20),
  logo: spec.logo || null,
};
if (T.dicomPort === T.httpPort) fail('the DICOM port and the local API port must differ');
if (!/^[a-z0-9][a-z0-9-]*$/.test(T.pkgName)) fail(`pkgName is not a valid package name: ${T.pkgName}`);
if (!/^[a-z0-9-]+$/.test(T.senderExe)) fail(`senderExe is not a valid file name: ${T.senderExe}`);

// Without a second receiver or a backup API, the primary stands in for it. The
// engine and main.js both de-duplicate candidates, so this is the same as "none".
const peer2 = T.peer2 || T.peer1;
const hostOf = (u) => new URL(u).host;
const apiHosts = [...new Set([hostOf(T.apiMain), ...(T.apiBackup ? [hostOf(T.apiBackup)] : [])])];

// ---- escaping for each language the values land in ---------------------------

const js = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; // single-quoted JS
const go = (s) => JSON.stringify(String(s)); // a JSON string is a valid Go string literal
const html = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- the edit primitive -------------------------------------------------------

const log = [];
function edit(rel, pairs) {
  const file = path.join(ROOT, rel);
  let text = fs.readFileSync(file, 'utf8');
  for (const [find, replace, expected = 1] of pairs) {
    const count = text.split(find).length - 1;
    if (count !== expected) {
      fail(`${rel}: expected ${expected} of ${JSON.stringify(find)}, found ${count}. The template has changed; update tools/customize.js.`);
    }
    text = text.split(find).join(replace);
  }
  fs.writeFileSync(file, text);
  log.push(`  ${rel} (${pairs.length} edit${pairs.length === 1 ? '' : 's'})`);
}

// ---- package.json: identity, installer names, engine filename ----------------

{
  const file = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.name = T.pkgName;
  pkg.version = T.version;
  pkg.description = `${T.productName} — DICOM Router`;
  pkg.author = T.productName;
  pkg.build.appId = T.appId;
  pkg.build.productName = T.productName;
  pkg.build.nsis.shortcutName = T.productName;
  let renamed = 0;
  for (const res of pkg.build.win.extraResources || []) {
    if (res.from === 'tarang-sender.exe') (res.to = `${T.senderExe}.exe`), renamed++;
  }
  for (const res of (pkg.build.mac && pkg.build.mac.extraResources) || []) {
    if (res.from === 'tarang-sender') res.to = T.senderExe;
  }
  if (renamed !== 1) fail('package.json: the Windows engine mapping (tarang-sender.exe) was not found');
  if (pkg.build.dmg) pkg.build.dmg.title = T.productName;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  log.push('  package.json');
}

// ---- Electron main process ----------------------------------------------------

edit('electron/main/main.js', [
  [`const PRODUCT_NAME        = '${FROM.productName}';`, `const PRODUCT_NAME        = ${js(T.productName)};`],
  [`const DEFAULT_DICOM_PORT  = ${FROM.dicomPort};`, `const DEFAULT_DICOM_PORT  = ${T.dicomPort};`],
  [`const DEFAULT_HTTP_PORT   = ${FROM.httpPort};`, `const DEFAULT_HTTP_PORT   = ${T.httpPort};`],
  [`const DEFAULT_AET         = '${FROM.aet}';`, `const DEFAULT_AET         = ${js(T.aet)};`],
  [`const SENDER_EXE_NAME = '${FROM.senderExe}';`, `const SENDER_EXE_NAME = ${js(T.senderExe)};`],
  [`const ROUTER1 = '${FROM.peer1}';`, `const ROUTER1 = ${js(T.peer1)};`],
  [`const ROUTER2 = '${FROM.peer2}';`, `const ROUTER2 = ${js(peer2)};`],
  [`const API_HOSTS = ${FROM.apiHosts};`, `const API_HOSTS = [${apiHosts.map(js).join(', ')}];`],
  [`    name: '${FROM.aet}',\n    url: ROUTER1,`, `    name: ${js(T.aet)},\n    url: ROUTER1,`],
  [`    username: '${FROM.peerUser}',\n    password: '${FROM.peerPass}',`, `    username: ${js(T.peerUser)},\n    password: ${js(T.peerPass)},`],
  [`  const FALLBACK = '${FROM.apiMain}/api';`, `  const FALLBACK = ${js(`${T.apiMain}/api`)};`],
  // Lossy JPEG 2000 compression: the default for a fresh install. A stored choice
  // (or the PACS's per-centre policy) still wins, exactly as before.
  [
    `    enabled: compressionSupported ? (cfg.compression?.enabled ?? false) : false,`,
    `    enabled: compressionSupported ? (cfg.compression?.enabled ?? ${T.compression}) : false,`,
  ],
]);

// ---- renderer -------------------------------------------------------------------

edit('electron/renderer/login.js', [
  [`const DEFAULT_API_URL   = '${FROM.apiMain}/api/auth/lab-login';`, `const DEFAULT_API_URL   = ${js(`${T.apiMain}/api/auth/lab-login`)};`],
  [`const DEFAULT_PEER_URL  = '${FROM.peer1}';`, `const DEFAULT_PEER_URL  = ${js(T.peer1)};`],
  [`const SETTINGS_PASSWORD = '${FROM.pin}';`, `const SETTINGS_PASSWORD = ${js(T.pin)};`],
  [`const API_HOSTS = ${FROM.apiHosts};`, `const API_HOSTS = [${apiHosts.map(js).join(', ')}];`],
  [`      name:        serverPeer.name        || '${FROM.aet}',`, `      name:        serverPeer.name        || ${js(T.aet)},`],
]);

edit('electron/renderer/app.js', [
  [`  const TAB_PASS = '${FROM.pin}';`, `  const TAB_PASS = ${js(T.pin)};`],
  [`  let chipPort = ${FROM.dicomPort};`, `  let chipPort = ${T.dicomPort};`],
  [`  let chipAET  = '${FROM.aet}';`, `  let chipAET  = ${js(T.aet)};`],
  [`  const PEER_ROUTER1 = '${FROM.peer1}';`, `  const PEER_ROUTER1 = ${js(T.peer1)};`],
  [`  const PEER_ROUTER2 = '${FROM.peer2}';`, `  const PEER_ROUTER2 = ${js(peer2)};`],
  [`    chipPort = boot.dicomPort || ${FROM.dicomPort};`, `    chipPort = boot.dicomPort || ${T.dicomPort};`],
  [`    chipAET  = boot.aet || '${FROM.aet}';`, `    chipAET  = boot.aet || ${js(T.aet)};`],
  ['      document.title = `' + FROM.productName + ' (${boot.instanceId})`;', '      document.title = `' + T.productName.replace(/[`$\\]/g, '\\$&') + ' (${boot.instanceId})`;'],
  [`  const DEFAULT_INACTIVE_MSG = 'Your account is inactive. Please contact ${FROM.productName}.';`, `  const DEFAULT_INACTIVE_MSG = ${js(`Your account is inactive. Please contact ${T.productName}.`)};`],
  [`cfg.dicom?.port || s.dicom_port || ${FROM.dicomPort}`, `cfg.dicom?.port || s.dicom_port || ${T.dicomPort}`, 2],
  [`cfg.dicom?.aet || '${FROM.aet}';`, `cfg.dicom?.aet || ${js(T.aet)};`],
]);

edit('electron/renderer/api.js', [
  [`    const port  = Number(qs.get('port') || ${FROM.httpPort});`, `    const port  = Number(qs.get('port') || ${T.httpPort});`],
  [`        aet: '${FROM.aet}',`, `        aet: ${js(T.aet)},`],
]);

edit('electron/renderer/settings-form.js', [
  [`placeholder="${FROM.aet}">`, `placeholder="${html(T.aet)}">`],
  [`config.dicom?.aet || '${FROM.aet}';`, `config.dicom?.aet || ${js(T.aet)};`],
]);

const wordmark = `${html(T.first)}<span class="brand-x">${html(T.tail)}</span>`;
edit('electron/renderer/index.html', [
  [`<title>${FROM.productName}</title>`, `<title>${html(T.productName)}</title>`],
  [`<span class="brand-name">${FROM.first}<span class="brand-x">${FROM.tail}</span></span>`, `<span class="brand-name">${wordmark}</span>`],
  [`contact ${FROM.productName}.</strong>`, `contact ${html(T.productName)}.</strong>`],
  [`Checked with the ${FROM.first} server about once a minute.`, `Checked with the ${html(T.productName)} server about once a minute.`],
]);

edit('electron/renderer/login.html', [
  [`<title>${FROM.productName}</title>`, `<title>${html(T.productName)}</title>`],
  [`<div class="wordmark">${FROM.first}<span class="brand-x">${FROM.tail}</span></div>`, `<div class="wordmark">${wordmark}</div>`],
  [`&copy; 2026 ${FROM.productName}</span>`, `&copy; ${new Date().getFullYear()} ${html(T.productName)}</span>`],
  [`placeholder="${FROM.apiMain}/api/auth/lab-login">`, `placeholder="${html(`${T.apiMain}/api/auth/lab-login`)}">`],
  [`placeholder="${FROM.peer1}">`, `placeholder="${html(T.peer1)}">`],
]);

// ---- Go engine defaults (used when config.json lacks a field) -------------------

edit('internal/config/config.go', [
  [`			Port:             ${FROM.dicomPort},\n			AET:              "${FROM.aet}",`, `			Port:             ${T.dicomPort},\n			AET:              ${go(T.aet)},`],
  [`		HTTP: HTTPConfig{\n			Port: ${FROM.httpPort},`, `		HTTP: HTTPConfig{\n			Port: ${T.httpPort},`],
  [`"${FROM.apiMain}/api/orthanc2/instance-exe-received"`, go(`${T.apiMain}/api/orthanc2/instance-exe-received`)],
  [`"${FROM.apiMain}/api/sender/error-logs"`, go(`${T.apiMain}/api/sender/error-logs`)],
  [`"${FROM.apiMain}/api/sender/lab-status"`, go(`${T.apiMain}/api/sender/lab-status`)],
  [`BaseURL:          "${FROM.apiMain}/api",`, `BaseURL:          ${go(`${T.apiMain}/api`)},`],
  [
    `FallbackBaseURLs: []string{"${FROM.apiBackup}/api"},`,
    `FallbackBaseURLs: []string{${T.apiBackup ? go(`${T.apiBackup}/api`) : ''}},`,
  ],
  [
    `			// Both transcode modes ship OFF — see LosslessConfig.\n			Enabled:               false,`,
    `			// Lossy default chosen when this router was built (Router Hub).\n			Enabled:               ${T.compression},`,
  ],
]);

edit('internal/labstatus/checker.go', [
  [`const DefaultInactiveMessage = "Your account is inactive. Please contact ${FROM.productName}."`, `const DefaultInactiveMessage = ${go(`Your account is inactive. Please contact ${T.productName}.`)}`],
]);

edit('internal/scp/dicomtls.go', [[`Organization: []string{"${FROM.productName}"},`, `Organization: []string{${go(T.productName)}},`]]);

// ---- installer: stop THIS product's engine, by its own name ---------------------

edit('build/installer.nsh', [
  [
    `  !if "\${APP_PACKAGE_NAME}" == "ganesham-teleradiology2"\n    nsExec::Exec 'taskkill /F /IM "ganesham2-sender.exe" /T'\n  !else\n    nsExec::Exec 'taskkill /F /IM "ganesham-sender.exe" /T'\n  !endif`,
    `  nsExec::Exec 'taskkill /F /IM "${T.senderExe}.exe" /T'`,
  ],
]);

// ---- artwork ------------------------------------------------------------------------
// The client's logo, or a neutral router mark: never Ganesham's artwork on another
// client's product.

{
  const source = T.logo ? path.resolve(path.dirname(specPath), T.logo) : path.join(ROOT, 'branding', 'default-logo.png');
  if (!fs.existsSync(source)) fail(`logo not found: ${source}`);
  fs.copyFileSync(source, path.join(ROOT, 'logo.png'));
  execFileSync(process.execPath, [path.join(ROOT, 'generate-ico.js')], { cwd: ROOT, stdio: 'inherit' });
  log.push(`  logo.png + electron icons (${T.logo ? 'client logo' : 'neutral default'})`);
}

// ---- the engine name must agree everywhere (the template's own check) ----------------

execFileSync(process.execPath, [path.join(ROOT, 'tools', 'check-engine-name.js')], { cwd: ROOT });

const summary = {
  productName: T.productName,
  pkgName: T.pkgName,
  appId: T.appId,
  version: T.version,
  senderExe: `${T.senderExe}.exe`,
  aet: T.aet,
  dicomPort: T.dicomPort,
  httpPort: T.httpPort,
  receivers: [...new Set([T.peer1, peer2])],
  apiHosts,
  compression: T.compression ? 'on (JPEG 2000 lossy)' : 'off',
};
console.log('Customised:');
console.log(log.join('\n'));
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(ROOT, 'router-spec.applied.json'), JSON.stringify(summary, null, 2) + '\n');
