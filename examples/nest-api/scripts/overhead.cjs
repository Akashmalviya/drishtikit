// Time added to one request by Drishtikit, measured without noise from a load generator:
// one connection, one request after the other, 20,000 requests per run, runs alternate off/on.
// The answer is the difference of the median time per request. Prints text lines for LOADTEST.md.
require('reflect-metadata');
const http = require('node:http');
const { NestFactory } = require('@nestjs/core');
const { memoryStore } = require('@drishtikit/mongo');
const { AcmeModule } = require('../dist/app.module.js');

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const paths = ['/teams', '/teams/t1', '/teams/t2/members', '/teams/t3', '/teams/zz'];
const roles = ['admin', 'manager', 'member'];

function one(port, i) {
  return new Promise((resolve) => {
    http.get(
      {
        port,
        host: '127.0.0.1',
        path: paths[i % 5],
        agent,
        headers: { 'x-user-id': `u${i % 200}`, 'x-team-id': `t${(i % 3) + 1}`, 'x-role': roles[i % 3], 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/120', 'x-app-version': '2026.11.16' },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
  });
}

async function run(store, n) {
  const app = await NestFactory.create(AcmeModule.register({ store, flushEveryMs: 3_600_000 }), { logger: false });
  await app.listen(0);
  const port = app.getHttpServer().address().port;
  for (let i = 0; i < 3000; i++) await one(port, i); // warm-up
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i++) await one(port, i);
  const micros = Number(process.hrtime.bigint() - start) / 1000 / n;
  await app.close();
  return micros;
}

(async () => {
  const n = 20_000;
  const off = [];
  const on = [];
  for (let round = 0; round < 4; round++) {
    off.push(await run(null, n));
    on.push(await run(memoryStore(), n));
  }
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const f = (x) => x.toFixed(1);
  console.log(`Time added to one request (one connection, ${n} requests per run, 4 runs each, alternating):`);
  console.log(`- without Drishtikit: ${off.map(f).join(', ')} microseconds per request (median ${f(median(off))}).`);
  console.log(`- with Drishtikit: ${on.map(f).join(', ')} microseconds per request (median ${f(median(on))}).`);
  console.log(`- Difference of the medians: ${f(median(on) - median(off))} microseconds (${((median(on) - median(off)) / 1000).toFixed(3)} ms). The target is less than 100 microseconds.`);
})();
