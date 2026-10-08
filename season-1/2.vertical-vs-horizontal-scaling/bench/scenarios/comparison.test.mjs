import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dockerMemoryBytes, selectMeasuredReports, summarizeComparison} from './comparison.mjs';

const since = '2026-10-06T07:00:00.0000000Z';
function trials() {
  return ['vertical', 'horizontal'].flatMap(topology => [1, 2, 3].map(run => {
    const replicas = topology === 'vertical' ? 1 : 4;
    return {
      topology, run, startedAt: '2026-10-06T07:00:00.001Z', duration: '10m', passed: true,
      synthetic: true, rate: 100, compression: 'off', cache: 'disabled', file: `${topology}-${run}.json`,
      configuration: Array.from({length: replicas}, () => ({cpus: 4 / replicas, memory: 4 * 1024 ** 3 / replicas, workers: 4 / replicas, image: 'sha256:' + 'a'.repeat(64), sourceTreeSha256: 'b'.repeat(64)})),
      limits: {mongoCpu: 1, mongoMemoryMiB: 768, gatewayCpu: 0.25, gatewayMemoryMiB: 128, loadCpu: 1, loadMemoryMiB: 512},
      dataset: {count: 10000, seed: 42, synthetic: true, sha256: 'c'.repeat(64)},
      telemetry: {scrapedReplicas: replicas, observedRequestDelta: 60000, snapshots: {
        poolCheckoutP95Seconds: [{value: 0.001}], workerRssBytes: [{value: 500000000}],
        worstWorkerEventLoopP99Seconds: [{value: 0.01}], gcP95Seconds: [{value: 0.002}],
        mongoCommandP95Seconds: [{labels: {command: 'find'}, value: 0.002}],
      }},
      result: {metrics: {http_reqs: {count: 60000, rate: 100}, http_req_failed: {value: 0}, checks: {value: 1}, dropped_iterations: {count: 0}, http_req_duration: {'p(95)': run + replicas, 'p(99)': run + replicas + 1}, data_received: {rate: 1000000}}},
      samples: Array.from({length: 120}, () => ({stats: [
        ...Array.from({length: replicas}, (_, index) => ({Name: `scaling-production-lab-api-${index + 1}`, CPUPerc: '10%', MemUsage: '200MiB / 4GiB'})),
        {Name: 'scaling-benchmark-1', CPUPerc: '20%'}, {Name: 'scaling-production-lab-mongo-1', CPUPerc: '10%'},
        {Name: 'scaling-production-lab-gateway-1', CPUPerc: '5%'},
      ]})),
    };
  }));
}

test('valid independent trials report median and spread without a capacity claim', () => {
  const summary = summarizeComparison(trials(), since);
  assert.deepEqual(summary.topologies.vertical.p95Ms, {median: 3, min: 2, max: 4});
  assert.equal(summary.topologies.horizontal.apiCpuPercentOfOneCore.median, 40);
  assert.equal(summary.topologies.vertical.requests, 180000);
  assert.equal(summary.topologies.horizontal.apiContainerMemoryBytes.median, 800 * 1024 ** 2);
  assert.equal(summary.requestedRate, 100);
  assert.equal(summary.lowerMedianP95AtTestedRate, 'vertical');
  assert.ok(summary.limitations.some(text => text.includes('maximum production capacity')));
});

test('Docker memory units distinguish binary and decimal quantities', () => {
  assert.equal(dockerMemoryBytes('1.5GiB / 4GiB'), 1.5 * 1024 ** 3);
  assert.equal(dockerMemoryBytes('200MB / 1GB'), 200000000);
  assert.equal(dockerMemoryBytes('25KiB / 1GiB'), 25 * 1024);
  assert.throws(() => dockerMemoryBytes('invalid'));
});

test('zero GC activity is recorded as unobserved, not a fake zero or missing instrument', () => {
  const reports = trials();
  reports[0].telemetry.snapshots.gcP95Seconds = [{value: null}];
  const summary = summarizeComparison(reports, since);
  assert.equal(summary.topologies.vertical.telemetry[0].gcP95Seconds[0].value, null);
  reports[0].telemetry.snapshots.gcP95Seconds = [];
  assert.throws(() => summarizeComparison(reports, since), /Missing GC telemetry/);
});

test('date selection uses timestamps instead of fractional-second string ordering', () => {
  const reports = trials();
  reports[0].startedAt = '2026-10-06T07:00:00.000Z';
  assert.equal(selectMeasuredReports(reports, since).length, 6);
  assert.throws(() => selectMeasuredReports(reports, 'invalid'));
});

test('warm-ups and prior comparison trials cannot fill missing measured runs', () => {
  const reports = trials();
  reports[0].duration = '2m';
  assert.throws(() => summarizeComparison(reports, since), /three complete/);
  reports[0].duration = '10m';
  reports[0].startedAt = '2026-10-06T06:59:59.999Z';
  assert.throws(() => summarizeComparison(reports, since), /three complete/);
});

for (const [name, mutate] of [
  ['duplicate trial IDs', r => {r[0].run = 2;}],
  ['different source image', r => {r[0].configuration[0].image = 'sha256:' + 'd'.repeat(64);} ],
  ['different source content', r => {r[0].configuration[0].sourceTreeSha256 = 'd'.repeat(64);} ],
  ['different dataset', r => {r[0].dataset.sha256 = 'd'.repeat(64);} ],
  ['unequal API budget', r => {r[0].configuration[0].cpus = 5;}],
  ['cached container mislabeled as cache off', r=>{r[0].configuration[0].publicCache=true;}],
  ['different arrival rate', r => {r[0].rate = 90;}],
  ['client failures', r => {r[0].result.metrics.http_req_failed.value = 0.001;}],
  ['dropped arrivals', r => {r[0].result.metrics.dropped_iterations.count = 1;}],
  ['failed content checks', r => {r[0].result.metrics.checks.value = 0.999;}],
  ['missing app traffic', r => {r[0].telemetry.observedRequestDelta = 1;}],
  ['missing worker telemetry', r => {r[0].telemetry.snapshots.workerRssBytes = [];}],
  ['saturated generator', r => {r[0].samples[0].stats.find(row => row.Name.startsWith('scaling-benchmark-')).CPUPerc = '95%';}],
  ['insufficient resource samples', r => {r[0].samples = r[0].samples.slice(0, 20);} ],
]) {
  test(`rejects ${name}`, () => {
    const reports = trials(); mutate(reports);
    assert.throws(() => summarizeComparison(reports, since));
  });
}
