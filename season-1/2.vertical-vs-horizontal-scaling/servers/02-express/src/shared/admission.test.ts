import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import express from 'express';
import { createAdmission } from './admission.ts';

test('admission validates configuration and rejects before expensive work without a wait queue', async () => {
  for (const value of [0, -1, 1.5, NaN, 1025]) assert.throws(() => createAdmission(value));
  let rejects = 0, downstream = 0;
  const admission = createAdmission(2, () => rejects++), app = express();
  const held: Array<() => void> = [];
  app.use(admission.middleware);
  app.get(['/health', '/ready', '/metrics'], (_req, res) => res.json({ ok: true }));
  app.use((_req, res) => { downstream++; held.push(() => { if (!res.writableEnded) res.json({ ok: true }); }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const first = fetch(base + '/work'), second = fetch(base + '/work');
  try {
    await wait(() => admission.snapshot().active === 2);
    const rejected = await fetch(base + '/work', { method: 'POST', body: 'unparsed body' });
    assert.equal(rejected.status, 503); assert.equal(rejected.headers.get('retry-after'), '1');
    assert.equal(rejected.headers.get('cache-control'), 'no-store');
    assert.equal((await rejected.json()).code, 'OVERLOADED');
    assert.equal(downstream, 2); assert.equal(rejects, 1);
    for (const path of ['/health', '/READY/', '/metrics']) assert.equal((await fetch(base + path)).status, 200);
    for (const path of ['/health/extra', '/metrics/private']) assert.equal((await fetch(base + path)).status, 503);
    assert.equal((await fetch(base + '/health', { method: 'POST' })).status, 503);
    assert.deepEqual(admission.snapshot(), { active: 2, limit: 2, highWater: 2, accepted: 2, rejected: 4 });
    held.forEach(release => release());
    await Promise.all([first, second]); await wait(() => admission.snapshot().active === 0);
    assert.equal(admission.snapshot().highWater, 2);
  } finally {
    held.forEach(release => release()); await Promise.allSettled([first, second]);
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
});

test('client disconnect releases a response slot exactly once and later traffic recovers', async () => {
  const admission = createAdmission(1), app = express();
  let lateRelease: (() => void) | undefined;
  app.use(admission.middleware);
  app.get('/held', (_req, res) => { lateRelease = () => res.end('late'); });
  app.get('/work', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = request(base + '/held'); client.on('error', () => {}); client.end();
  try {
    await wait(() => admission.snapshot().active === 1);
    client.destroy(); await wait(() => admission.snapshot().active === 0);
    lateRelease?.();
    assert.equal((await fetch(base + '/work')).status, 200);
    await wait(() => admission.snapshot().active === 0);
    assert.equal(admission.snapshot().accepted, 2);
    assert.equal(admission.snapshot().highWater, 1);
  } finally { client.destroy(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

async function wait(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition() && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
  assert.ok(condition(), 'HTTP lifecycle did not reach expected state');
}
