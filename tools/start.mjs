// One command to bring Router Hub up:  npm start
//
//   1. writes .env with generated passwords the first time
//   2. makes sure MongoDB is reachable - if MONGO_URI is local and nothing is
//      listening, launches the portable mongod from .runtime/ (fetching it on first run)
//   3. starts the server

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');

if (!existsSync(envFile)) {
  const password = () => randomBytes(9).toString('base64url');
  writeFileSync(
    envFile,
    [
      '# Router Hub configuration. Restart after editing.',
      'PORT=4600',
      'MONGO_URI=mongodb://127.0.0.1:27017',
      'MONGO_DB=routerhub',
      '',
      '# Address other people reach this server on. Shared links are built from it.',
      '# Leave empty to use whatever address you opened the app with.',
      'PUBLIC_BASE_URL=',
      '',
      '# Set both when the app sits behind an HTTPS reverse proxy.',
      'SECURE_COOKIES=false',
      'TRUST_PROXY=',
      '',
      '# Largest installer accepted, in MB.',
      'MAX_UPLOAD_MB=2048',
      '',
      '# Used once, on first start, to create the two accounts.',
      '# After that, change passwords in the app under Settings.',
      'MASTER_USERNAME=master',
      `MASTER_PASSWORD=${password()}`,
      'HELPER_USERNAME=helper',
      `HELPER_PASSWORD=${password()}`,
      '',
    ].join('\n'),
  );
  console.log(`  Created ${envFile} with generated sign-in passwords.`);
}
process.loadEnvFile(envFile);

const portOpen = (host, port) =>
  new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1500 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });

async function ensureMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
  const local = /^mongodb:\/\/(?:[^@/]+@)?(localhost|127\.0\.0\.1)(?::(\d+))?(?:[/?]|$)/.exec(uri);
  if (!local) return; // remote or Atlas - not ours to start
  const port = Number(local[2] || 27017);
  if (await portOpen('127.0.0.1', port)) return;

  const mongod = join(root, '.runtime', 'mongodb', 'bin', 'mongod.exe');
  if (!existsSync(mongod)) {
    if (process.platform !== 'win32') {
      throw new Error(`Nothing is listening on ${uri}. Start MongoDB, or set MONGO_URI in .env.`);
    }
    console.log('  MongoDB is not running and no portable copy is present - fetching one ...');
    const fetched = spawnSync(process.execPath, [join(root, 'tools', 'fetch-mongod.mjs')], { stdio: 'inherit' });
    if (fetched.status !== 0) throw new Error('Could not fetch mongod. Install MongoDB or set MONGO_URI in .env.');
  }

  const dataDir = join(root, '.data', 'mongo');
  mkdirSync(dataDir, { recursive: true });
  console.log(`  Starting bundled MongoDB on port ${port} (data in ${dataDir}) ...`);
  // Detached on purpose: the database keeps running if this window closes, the way a service would.
  spawn(
    mongod,
    ['--dbpath', dataDir, '--bind_ip', '127.0.0.1', '--port', String(port), '--logpath', join(dataDir, 'mongod.log'), '--logappend'],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ).unref();

  for (let i = 0; i < 60; i++) {
    if (await portOpen('127.0.0.1', port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`MongoDB did not come up. See ${join(dataDir, 'mongod.log')}`);
}

try {
  await ensureMongo();
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

if (!existsSync(join(root, 'web', 'dist', 'index.html'))) {
  console.log('  Building the interface (first run) ...');
  const built = spawnSync('npm run build', { cwd: join(root, 'web'), stdio: 'inherit', shell: true });
  if (built.status !== 0) console.error('  Interface build failed - run "npm run setup" and start again.');
}

await import('../server/src/index.js');
