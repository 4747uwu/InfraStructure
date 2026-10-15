// Router Builder worker. Runs in its own container (builder/Dockerfile) next to the hub.
//
// Takes queued jobs from the hub's database one at a time and, for each:
//   1. copies the router template (/template, i.e. ultimate/) into a fresh workdir
//   2. applies the client's settings with tools/customize.js
//   3. builds the engine for Windows 7+ (Go 1.20.14, windows/386)
//   4. packages the NSIS installer with electron-builder (Wine handles the Windows bits)
//   5. uploads the installer to the hub as a new Windows build of that client
// Progress and every line of output go back to the job, where the Build page shows them.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createReadStream, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017';
const MONGO_DB = process.env.MONGO_DB || 'routerhub';
const HUB_URL = (process.env.HUB_URL || 'http://app:4600').replace(/\/$/, '');
const TEMPLATE = process.env.TEMPLATE_DIR || '/template';
const WORK = process.env.WORK_DIR || '/work/current';
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 25 * 60_000);
const VERSION = '1.0.0';
// Production runs on Linux (builder/Dockerfile). Windows is supported only so the worker can be
// exercised on a developer machine: commands need a shell there, and process groups do not exist.
const WINDOWS = process.platform === 'win32';

const mongo = await new MongoClient(MONGO_URI).connect();
const db = mongo.db(MONGO_DB);
const builds = db.collection('builds');
const status = db.collection('builderStatus');
const settings = db.collection('settings');

let currentJob = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- heartbeat: lets the Build page say whether a builder is listening ----------

async function heartbeat() {
  await status.updateOne(
    { _id: 'main' },
    { $set: { lastSeen: new Date(), busy: currentJob ? String(currentJob) : null, version: VERSION, host: hostname() } },
    { upsert: true },
  );
}
setInterval(() => heartbeat().catch(() => {}), 10_000).unref();
await heartbeat();

// A job left "running" by a builder that died mid-build will never finish by itself.
await builds.updateMany(
  { status: 'running' },
  { $set: { status: 'failed', step: 'done', finishedAt: new Date(), error: 'The builder restarted during this build. Start it again.' } },
);

// ---- logging: batched into the job document, last 4000 lines kept ---------------

function makeLogger(jobId) {
  let pending = [];
  let timer = null;
  const flush = async () => {
    timer = null;
    if (!pending.length) return;
    const lines = pending;
    pending = [];
    await builds.updateOne({ _id: jobId }, { $push: { log: { $each: lines, $slice: -4000 } } });
  };
  const write = (line) => {
    // Colour codes and progress-bar carriage returns are noise in a stored log.
    const clean = String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').slice(0, 600);
    if (!clean.trim()) return;
    pending.push(clean);
    if (!timer) timer = setTimeout(() => flush().catch(() => {}), 800);
  };
  return { write, flush };
}

async function setStep(jobId, step, log) {
  log.write(`==> ${step}`);
  await builds.updateOne({ _id: jobId }, { $set: { step } });
}

// ---- running a command, stoppable by cancel or timeout -----------------------------

class Stopped extends Error {}

function run(cmd, args, { cwd, env, log, jobId, deadline }) {
  return new Promise((resolve, reject) => {
    log.write(`$ ${cmd} ${args.join(' ')}`);
    // Its own process group, so a cancel takes down npx -> electron-builder -> wine too.
    // A Windows shell would split an argument like -ldflags "-X a=b -s -w" at its spaces.
    const argv = WINDOWS ? args.map((x) => (/\s/.test(x) ? `\"${x}\"` : x)) : args;
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, detached: !WINDOWS, shell: WINDOWS, windowsHide: true });
    let carry = '';
    const onData = (chunk) => {
      const text = carry + chunk.toString();
      const lines = text.split('\n');
      carry = lines.pop();
      lines.forEach(log.write);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let stopReason = null;
    const kill = () => {
      try {
        if (WINDOWS) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const watch = setInterval(async () => {
      if (Date.now() > deadline) {
        stopReason = 'The build took longer than 25 minutes and was stopped.';
        kill();
        return;
      }
      const job = await builds.findOne({ _id: jobId }, { projection: { cancelRequested: 1 } }).catch(() => null);
      if (job?.cancelRequested) {
        stopReason = 'Cancelled.';
        kill();
      }
    }, 2000);

    child.on('error', (err) => {
      clearInterval(watch);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(watch);
      if (carry) log.write(carry);
      if (stopReason) return reject(new Stopped(stopReason));
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

function capture(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, shell: WINDOWS, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

// ---- upload to the hub ----------------------------------------------------------------

async function upload(file, job, log) {
  const token = (await settings.findOne({ _id: 'main' }, { projection: { builderToken: 1 } }))?.builderToken;
  if (!token) throw new Error('The hub has not issued a builder credential yet. Restart the app container.');

  const hash = createHash('sha256');
  await new Promise((resolve, reject) => createReadStream(file).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject));
  const sha256 = hash.digest('hex');
  const fileName = file.split(/[\\/]/).pop();
  const size = statSync(file).size;
  log.write(`Uploading ${fileName} (${(size / 1048576).toFixed(1)} MB) to the hub`);

  const query = new URLSearchParams({
    client: String(job.clientId),
    version: job.spec.version,
    platform: 'windows',
    filename: fileName,
    sha256,
    notes: `Built by Router Builder: DICOM ${job.spec.dicomPort}, AE ${job.spec.aet}, compression ${job.spec.compression ? 'on' : 'off'}`,
  });
  const res = await fetch(`${HUB_URL}/api/upload?${query}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': String(size) },
    body: Readable.toWeb(createReadStream(file)),
    duplex: 'half',
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) {
    log.write(`The hub already has this exact file: ${body.error}`);
    return { duplicate: true, message: body.error };
  }
  if (!res.ok) throw new Error(`The hub refused the upload (HTTP ${res.status}): ${body.error || ''}`);
  return {
    releaseId: body.release.id,
    version: body.release.version,
    build: body.release.build,
    fileName: body.release.fileName,
    size: body.release.size,
    clientSlug: body.client.slug,
  };
}

// ---- one job ---------------------------------------------------------------------------

async function buildOne(job) {
  const log = makeLogger(job._id);
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  const ctx = { log, jobId: job._id, deadline };
  currentJob = job._id;
  await heartbeat();

  try {
    await setStep(job._id, 'preparing', log);
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    // Everything but node_modules is copied; dependencies are shared from the image.
    cpSync(TEMPLATE, WORK, { recursive: true, filter: (src) => !src.startsWith(join(TEMPLATE, 'node_modules')) });
    symlinkSync(join(TEMPLATE, 'node_modules'), join(WORK, 'node_modules'), WINDOWS ? 'junction' : 'dir');
    const spec = { ...job.spec };
    if (job.logo) {
      writeFileSync(join(WORK, 'client-logo.png'), job.logo.buffer);
      spec.logo = 'client-logo.png';
    }
    writeFileSync(join(WORK, 'spec.json'), JSON.stringify(spec, null, 2));
    log.write(`Building ${job.spec.productName} ${job.spec.version} for ${job.clientName}`);

    await setStep(job._id, 'customizing', log);
    await run('node', ['tools/customize.js', 'spec.json'], { cwd: WORK, ...ctx });

    await setStep(job._id, 'engine', log);
    await run('go', ['build', '-ldflags', `-X main.version=${job.spec.version} -s -w`, '-o', 'tarang-sender.exe', './cmd/tarang-sender/'], {
      cwd: WORK,
      env: { GOOS: 'windows', GOARCH: '386', CGO_ENABLED: '0' },
      ...ctx,
    });
    // Windows 7 support depends on the compiling toolchain, so check the binary itself.
    const built = await capture('go', ['version', 'tarang-sender.exe'], { cwd: WORK });
    log.write(built);
    if (!built.includes('go1.20.')) throw new Error(`The engine was built with the wrong Go version (${built}); it would not run on Windows 7.`);

    await setStep(job._id, 'packaging', log);
    await run('npx', ['--no-install', 'electron-builder', '--win', '--ia32', '--publish', 'never'], { cwd: WORK, env: { WINEDEBUG: '-all' }, ...ctx });
    const installer = readdirSync(join(WORK, 'dist')).find((f) => /Setup .*\.exe$/i.test(f));
    if (!installer) throw new Error('electron-builder finished but no installer was found in dist/.');

    await setStep(job._id, 'uploading', log);
    const result = await upload(join(WORK, 'dist', installer), job, log);

    await log.flush();
    await builds.updateOne({ _id: job._id }, { $set: { status: 'succeeded', step: 'done', finishedAt: new Date(), result } });
    log.write(result.duplicate ? 'Done (the hub already had this build).' : `Done: ${result.fileName} is build ${result.build} of ${job.clientName}.`);
  } catch (err) {
    const cancelled = err instanceof Stopped && err.message === 'Cancelled.';
    log.write(`!! ${err.message}`);
    await builds.updateOne(
      { _id: job._id },
      // The step is left where it stopped, so the page can show which one failed.
      { $set: { status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date(), error: err.message } },
    );
  } finally {
    await log.flush().catch(() => {});
    currentJob = null;
    await heartbeat().catch(() => {});
    // The installer is on the hub now; the workdir (hundreds of MB) is not kept.
    rmSync(WORK, { recursive: true, force: true });
  }
}

// ---- main loop -------------------------------------------------------------------------

console.log(`Router Builder ${VERSION} ready; template ${TEMPLATE}, hub ${HUB_URL}`);
for (;;) {
  const job = await builds.findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'running', step: 'preparing', startedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
  if (!job) {
    await sleep(3000);
    continue;
  }
  console.log(`Building ${job.spec.productName} (${job._id})`);
  await buildOne(job);
}
