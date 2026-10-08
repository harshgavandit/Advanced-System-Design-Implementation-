import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {nodeServerProcesses} from './process-rows.mjs';

const topic = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const report = {startedAt: new Date().toISOString(), passed: false, synthetic: true};
function docker(args) {
  const result = spawnSync('docker', args, {encoding: 'utf8', timeout: 15000});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function query(expression) {
  const response = await fetch('http://127.0.0.1:19092/api/v1/query?query=' + encodeURIComponent(expression), {signal: AbortSignal.timeout(5000)});
  assert.ok(response.ok);
  const body = await response.json();
  assert.equal(body.status, 'success');
  return body.data.result.map(row => ({worker: row.metric.worker, value: Number(row.value[1])}));
}
const ids = docker(['ps', '--filter', 'label=com.docker.compose.project=scaling-production-lab', '--filter', 'label=com.docker.compose.service=api', '--format', '{{.ID}}']).split(/\r?\n/).filter(Boolean);
assert.equal(ids.length, 1, 'Use the isolated Vertical topology for this check');
const container = JSON.parse(docker(['inspect', ids[0]]))[0];
assert.equal(container.Config.Labels['scaling.owner'], 'production-lab');
assert.equal(container.HostConfig.NanoCpus, 4e9);
assert.equal(container.HostConfig.Memory, 4 * 1024 ** 3);
assert.equal(container.Config.Env.find(value => value.startsWith('WORKERS=')), 'WORKERS=4');

try {
  report.image = container.Image;
  report.sourceTreeSha256 = container.Config.Labels['org.scaling.source.sha256'];
  const processRows = nodeServerProcesses(docker(['top', ids[0], '-eo', 'pid,ppid,comm,args']));
  assert.equal(processRows.length, 5, 'Expect one supervisor and four serving Node processes');
  report.nodeProcessCount = processRows.length;
  const expected = ['1', '2', '3', '4'];
  let slots = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    slots = (await query('count by (worker) (runtime_process_resident_memory_bytes{job="production-lab-api"})')).map(row => row.worker).sort();
    if (JSON.stringify(slots) === JSON.stringify(expected)) break;
    await new Promise(done => setTimeout(done, 500));
  }
  assert.deepEqual(slots, expected, 'All serving workers must contribute runtime metrics');
  report.workerSlots = slots;
  const expression = 'sum by (worker) (app_http_requests_total{job="production-lab-api",route="/products",method="GET",status_code="200"})';
  const before = new Map((await query(expression)).map(row => [row.worker, row.value]));
  const child = spawn(process.execPath, [resolve(topic, 'bench/scenarios/run.mjs'), '--topology=vertical', '--run=9', '--rate=100', '--duration=1m'], {stdio: ['ignore', 'inherit', 'inherit']});
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'Worker distribution load check failed');
  const after = await query(expression);
  report.successfulCatalogRequestsPerWorker = after.map(row => ({worker: row.worker, requests: row.value - (before.get(row.worker) || 0)}));
  assert.deepEqual(report.successfulCatalogRequestsPerWorker.map(row => row.worker).sort(), expected);
  assert.ok(report.successfulCatalogRequestsPerWorker.every(row => row.requests > 0), 'Every worker must actually serve catalog requests, not only exist');
  report.limitations = ['A separate one-minute worker-distribution probe, not an additional ten-minute comparison trial.', 'Cluster workers share one container and do not represent independent host failure domains.'];
  report.passed = true;
  console.log('CLUSTER_WORKERS_PASS four serving workers, one supervisor, every worker handles catalog traffic');
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(topic, 'infra/compose/artifacts/cluster-workers.json'), JSON.stringify(report, null, 2) + '\n');
}
