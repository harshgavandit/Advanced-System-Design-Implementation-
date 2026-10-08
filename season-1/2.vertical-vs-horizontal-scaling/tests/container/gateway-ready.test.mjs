import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {waitForGateway} from './gateway-ready.mjs';

test('waits through stale upstream failures before returning a ready gateway', async () => {
  let calls = 0;
  const server = createServer((_req, res) => {
    res.writeHead(++calls < 3 ? 504 : 200, {'content-type':'application/json'});
    res.end(JSON.stringify({status: calls < 3 ? 'unavailable' : 'ready'}));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    await waitForGateway(`http://127.0.0.1:${server.address().port}`, {timeoutMs: 3000, intervalMs: 10});
    assert.ok(calls >= 4, 'Two consecutive successful readiness checks are required');
  } finally { await new Promise(done => server.close(done)); }
});
