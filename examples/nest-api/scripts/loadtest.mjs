// Load test: the Acme API with and without Drishtikit.
// 200 requests each second for 60 seconds (change with RATE and DURATION).
// Usage: npm run build && npm run loadtest -w drishtikit-example-nest-api
// The "with" run uses a throw-away MongoDB in memory (mongodb-memory-server), never a real database.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import autocannon from 'autocannon';
import { MongoMemoryServer } from 'mongodb-memory-server';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DURATION = Number(process.env.DURATION ?? 60);
const RATE = Number(process.env.RATE ?? 200);
const WARMUP = Number(process.env.WARMUP ?? 5);
const PORT = 3411;
const URL = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rss = (pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024;

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${URL}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('API did not start');
}

const paths = ['/teams', '/teams/t1', '/teams/t2/members', '/teams/t3', '/teams/zz'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const requests = paths.map((path) => ({
  method: 'GET',
  path,
  setupRequest: (req) => {
    req.headers = {
      ...req.headers,
      'x-user-id': `u${Math.floor(Math.random() * 200)}`,
      'x-team-id': pick(['t1', 't2', 't3']),
      'x-role': pick(['admin', 'manager', 'member']),
      'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile',
      'x-app-version': '2026.11.16',
    };
    return req;
  },
}));

function run(seconds) {
  return new Promise((resolve, reject) => {
    const samples = [];
    const instance = autocannon({ url: URL, duration: seconds, connections: 10, overallRate: RATE, requests }, (err, result) => (err ? reject(err) : resolve({ result, samples })));
    instance.on('response', (_client, _status, _bytes, ms) => samples.push(ms));
  });
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

async function measure(label, withDrishti, store) {
  let mongo;
  const env = { ...process.env, PORT: String(PORT), WITH_DRISHTI: withDrishti ? '1' : '0', FLUSH_EVERY_MS: process.env.FLUSH_EVERY_MS ?? '15000' };
  delete env.DRISHTI_MONGODB_URI;
  if (withDrishti && store === 'mongo') {
    mongo = await MongoMemoryServer.create();
    env.DRISHTI_MONGODB_URI = mongo.getUri();
  }
  const child = spawn(process.execPath, [join(root, 'dist/main.js')], { env, stdio: 'ignore' });
  try {
    await waitReady();
    await run(WARMUP);
    const rssStart = rss(child.pid);
    let rssPeak = rssStart;
    const timer = setInterval(() => (rssPeak = Math.max(rssPeak, rss(child.pid))), 1000);
    const { result, samples } = await run(DURATION);
    clearInterval(timer);
    const rssEnd = rss(child.pid);
    rssPeak = Math.max(rssPeak, rssEnd);
    samples.sort((a, b) => a - b);
    return {
      label,
      requests: result.requests.total,
      errors: result.errors,
      non2xx: result.non2xx,
      p50: quantile(samples, 0.5),
      p95: quantile(samples, 0.95),
      p99: quantile(samples, 0.99),
      mean: samples.reduce((a, b) => a + b, 0) / samples.length,
      rssStartMb: rssStart,
      rssPeakMb: rssPeak,
      rssEndMb: rssEnd,
    };
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    if (mongo) await mongo.stop();
  }
}

// MODES: for example "off,mongo" (default) or "off,memory,mongo". ROUNDS: how many times to repeat the list.
// The runs are interleaved (off, mongo, off, mongo), so slow time on the machine hits both modes.
const MODES = (process.env.MODES ?? 'off,mongo').split(',');
const ROUNDS = Number(process.env.ROUNDS ?? 1);
const NAMES = { off: 'without Drishtikit', memory: 'with Drishtikit (memory store)', mongo: 'with Drishtikit (MongoDB in memory)' };
const results = [];
for (let round = 1; round <= ROUNDS; round++) {
  for (const mode of MODES) {
    console.log(`Round ${round}: ${NAMES[mode]} (${RATE} requests each second for ${DURATION} s)...`);
    results.push({ ...(await measure(`${NAMES[mode]}, round ${round}`, mode !== 'off', mode)), mode });
  }
}

const f = (n, d = 3) => n.toFixed(d);
const median = (list) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)];
const summary = (mode) => {
  const own = results.filter((r) => r.mode === mode);
  return { p50: median(own.map((r) => r.p50)), p95: median(own.map((r) => r.p95)), peak: median(own.map((r) => r.rssPeakMb)) };
};
const base = summary('off');
const diffLines = MODES.filter((m) => m !== 'off').map((m) => {
  const w = summary(m);
  return `Median over ${ROUNDS} round(s), ${NAMES[m]} minus without: p50 ${f(w.p50 - base.p50)} ms, p95 ${f(w.p95 - base.p95)} ms, memory peak ${f(w.peak - base.peak, 1)} MB.`;
});
const lines = [
  '# Load test result',
  '',
  `Acme example API. ${RATE} requests each second for ${DURATION} seconds (after ${WARMUP} seconds of warm-up), 10 connections.`,
  'Mixed routes (one in five answers 404 on purpose), 200 different people, 3 teams. The "with" runs flush each 15 seconds (the MongoDB mode writes to a MongoDB in memory).',
  '',
  '| Run | Requests | Errors | 404 (expected) | p50 (ms) | p95 (ms) | p99 (ms) | Mean (ms) | Memory at start (MB) | Memory peak (MB) | Memory at end (MB) |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.label} | ${r.requests} | ${r.errors} | ${r.non2xx} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.mean)} | ${f(r.rssStartMb, 1)} | ${f(r.rssPeakMb, 1)} | ${f(r.rssEndMb, 1)} |`),
  '',
  ...diffLines,
  '',
  '',
  `Date: ${new Date().toISOString()}. Node ${process.version}.`,
  '',
];
let overhead = '';
if (process.env.OVERHEAD !== '0') {
  console.log('Measuring the time added to one request...');
  overhead = execFileSync(process.execPath, [join(here, 'overhead.cjs')], { cwd: root }).toString();
}
lines.splice(lines.length - 3, 0, '## Time added to one request', '', 'The load numbers above include the noise of the load generator, which shares this machine. This second test removes that noise.', '', overhead.trim().split('\n').join('\n'), '');
writeFileSync(process.env.OUT ?? join(root, 'LOADTEST.md'), lines.join('\n'));
console.log(lines.join('\n'));
