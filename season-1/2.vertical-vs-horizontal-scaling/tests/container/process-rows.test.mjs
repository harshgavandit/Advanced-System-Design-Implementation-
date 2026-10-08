import assert from 'node:assert/strict';
import test from 'node:test';
import {nodeServerProcesses} from './process-rows.mjs';

test('counts relative and absolute Node entrypoints without counting the init wrapper', () => {
  const output = `PID PPID COMMAND COMMAND
35932 35909 docker-init /sbin/docker-init -- docker-entrypoint.sh node dist/server.js
35955 35932 MainThread node dist/server.js
35964 35955 MainThread /usr/local/bin/node /app/dist/server.js
35965 35955 MainThread /usr/local/bin/node /app/dist/server.js
35966 35955 MainThread /usr/local/bin/node /app/dist/server.js
35972 35955 MainThread /usr/local/bin/node /app/dist/server.js`;
  assert.equal(nodeServerProcesses(output).length, 5);
  assert.equal(nodeServerProcesses('1 0 MainThread node dist/container.js').length, 0);
});
