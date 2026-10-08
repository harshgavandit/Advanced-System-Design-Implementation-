import assert from 'node:assert/strict';

function spread(values) {
  assert.ok(values.length && values.every(Number.isFinite), 'Missing or invalid measurements');
  const sorted = [...values].sort((a, b) => a - b);
  return {median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1)};
}

export function dockerMemoryBytes(usage) {
  const match = usage.split('/', 1)[0].trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB)$/);
  assert.ok(match, 'Invalid Docker memory usage');
  const multiplier = {B: 1, kB: 1000, KB: 1000, KiB: 1024, MB: 1000 ** 2, MiB: 1024 ** 2, GB: 1000 ** 3, GiB: 1024 ** 3};
  return Number(match[1]) * multiplier[match[2]];
}

export function selectMeasuredReports(reports, since) {
  const boundary = Date.parse(since);
  assert.ok(Number.isFinite(boundary), 'A valid comparison start timestamp is required');
  return reports.filter(report => Date.parse(report.startedAt) >= boundary && report.duration === '10m' && report.run >= 1 && report.run <= 3);
}

export function summarizeComparison(reports, since) {
  const measured = selectMeasuredReports(reports, since);
  const summary = {
    startedAfter: since, completedAt: new Date().toISOString(), passed: true,
    workload: '10000 synthetic products, fixed catalog GET, compression off, cache off',
    topologies: {},
    limitations: [
      'These trials measure the declared arrival rate; they do not establish maximum production capacity.',
      'Three sequential trials per topology use a warmed shared database.',
      'CPU observations are sampled and include the whole API container, including the vertical supervisor.',
      'Mongo/GC histogram estimates use final five-minute rates. RSS and event-loop gauges are final-scrape snapshots, not whole-run maxima.',
      'All replicas share one local Docker host and one MongoDB primary; this is not an availability-zone test.',
      'The Docker host also runs pre-existing applications. API/data/generator budgets are fixed, but the host is not dedicated to this experiment.',
    ],
  };
  const images = new Set(), sources = new Set(), datasets = new Set(), rates = new Set();
  for (const topology of ['vertical', 'horizontal']) {
    const trials = measured.filter(report => report.topology === topology).sort((a, b) => a.run - b.run);
    assert.equal(trials.length, 3, `${topology} must have three complete measured trials`);
    assert.deepEqual(trials.map(report => report.run), [1, 2, 3], `${topology} requires distinct trial numbers`);
    const apiCpu = [], generatorCpu = [], mongoCpu = [], gatewayCpu = [], apiMemory = [];
    const sampling = [];
    for (const trial of trials) {
      assert.equal(trial.passed, true, `${topology} trial ${trial.run} did not pass`);
      assert.equal(trial.synthetic, true);
      assert.equal(trial.compression, 'off');
      assert.equal(trial.cache, 'disabled');
      assert.ok(Number.isInteger(trial.rate) && trial.rate > 0);
      rates.add(trial.rate);
      const count = topology === 'vertical' ? 1 : 4;
      assert.equal(trial.configuration.length, count);
      assert.equal(trial.telemetry.scrapedReplicas, count, 'Every API replica must be scraped');
      for (const config of trial.configuration) {
        assert.notEqual(config.publicCache,true,'A cache-off report cannot contain an enabled cache');
        assert.equal(config.cpus, topology === 'vertical' ? 4 : 1);
        assert.equal(config.memory, (topology === 'vertical' ? 4 : 1) * 1024 ** 3);
        assert.equal(config.workers, topology === 'vertical' ? 4 : 1);
        assert.match(config.image, /^sha256:[a-f0-9]{64}$/);
        assert.match(config.sourceTreeSha256, /^[a-f0-9]{64}$/);
        images.add(config.image); sources.add(config.sourceTreeSha256);
      }
      assert.equal(trial.limits.mongoCpu, 1);
      assert.equal(trial.limits.mongoMemoryMiB, 768);
      assert.equal(trial.limits.gatewayCpu, 0.25);
      assert.equal(trial.limits.gatewayMemoryMiB, 128);
      assert.equal(trial.limits.loadCpu, 1);
      assert.equal(trial.limits.loadMemoryMiB, 512);
      assert.equal(trial.dataset.count, 10000);
      assert.equal(trial.dataset.seed, 42);
      assert.equal(trial.dataset.synthetic, true);
      assert.match(trial.dataset.sha256, /^[a-f0-9]{64}$/);
      datasets.add(JSON.stringify(trial.dataset));
      const metrics = trial.result.metrics;
      assert.equal(metrics.http_req_failed.value, 0, 'Client errors invalidate the comparison');
      assert.equal(metrics.checks.value, 1, 'Every content and transfer check must pass');
      assert.equal(metrics.dropped_iterations.count, 0, 'Dropped arrivals invalidate the comparison');
      assert.ok(metrics.http_req_duration['p(95)'] < 150);
      assert.ok(metrics.http_req_duration['p(99)'] < 300);
      assert.ok(metrics.http_reqs.count >= trial.rate * 600 * 0.98, 'Insufficient completed arrivals');
      assert.ok(trial.telemetry.observedRequestDelta >= metrics.http_reqs.count * 0.98, 'App telemetry does not cover client traffic');
      const snapshots = trial.telemetry.snapshots;
      for (const field of ['poolCheckoutP95Seconds', 'workerRssBytes', 'worstWorkerEventLoopP99Seconds']) {
        assert.ok(snapshots[field]?.some(row => Number.isFinite(row.value)), `Missing ${field} telemetry`);
      }
      assert.ok(snapshots.gcP95Seconds?.length > 0 && snapshots.gcP95Seconds.every(row => row.value === null || Number.isFinite(row.value)), 'Missing GC telemetry; null means no observed GC in the rate window');
      assert.ok(snapshots.mongoCommandP95Seconds.some(row => row.labels.command === 'find' && Number.isFinite(row.value)), 'Missing database find timing');
      let completeSamples = 0;
      for (const sample of trial.samples) {
        if (!sample.stats) continue;
        const apis = sample.stats.filter(row => row.Name.startsWith('scaling-production-lab-api-'));
        const generator = sample.stats.find(row => row.Name.startsWith('scaling-benchmark-'));
        const mongo = sample.stats.find(row => row.Name === 'scaling-production-lab-mongo-1');
        const gateway = sample.stats.find(row => row.Name === 'scaling-production-lab-gateway-1');
        if (apis.length !== count || !generator || !mongo || !gateway) continue;
        const cpu = row => Number(row.CPUPerc.replace('%', ''));
        const readings = [...apis, generator, mongo, gateway].map(cpu);
        assert.ok(readings.every(value => Number.isFinite(value) && value >= 0), 'Invalid resource sample');
        apiCpu.push(apis.reduce((sum, row) => sum + cpu(row), 0));
        apiMemory.push(apis.reduce((sum, row) => sum + dockerMemoryBytes(row.MemUsage), 0));
        generatorCpu.push(cpu(generator)); mongoCpu.push(cpu(mongo)); gatewayCpu.push(cpu(gateway));
        completeSamples++;
      }
      assert.ok(completeSamples >= 96, 'At least 80% of five-second resource samples must be complete');
      sampling.push({run: trial.run, completeSamples, recordedSamples: trial.samples.length});
    }
    assert.ok(Math.max(...generatorCpu) < 90, 'Load generator saturation requires another experiment');
    summary.topologies[topology] = {
      trials: trials.map(report => report.file), sampling,
      requests: trials.reduce((sum, report) => sum + report.result.metrics.http_reqs.count, 0),
      achievedRps: spread(trials.map(report => report.result.metrics.http_reqs.rate)),
      p95Ms: spread(trials.map(report => report.result.metrics.http_req_duration['p(95)'])),
      p99Ms: spread(trials.map(report => report.result.metrics.http_req_duration['p(99)'])),
      dataOutBytesPerSecond: spread(trials.map(report => report.result.metrics.data_received.rate)),
      apiCpuPercentOfOneCore: spread(apiCpu), generatorCpuPercentOfOneCore: spread(generatorCpu),
      mongoCpuPercentOfOneCore: spread(mongoCpu), gatewayCpuPercentOfOneCore: spread(gatewayCpu),
      apiContainerMemoryBytes: spread(apiMemory),
      failures: trials.map(report => report.result.metrics.http_req_failed.value),
      droppedIterations: trials.map(report => report.result.metrics.dropped_iterations.count),
      telemetryWindows: {poolCheckoutP95Seconds: 'final 5-minute rate', mongoCommandP95Seconds: 'final 5-minute rate', gcP95Seconds: 'final 5-minute rate; null when no events', workerRssBytes: 'final scrape, sum across serving workers', worstWorkerEventLoopP99Seconds: 'final scrape, maximum across worker gauge values'},
      telemetry: trials.map(report => ({run: report.run, ...report.telemetry.snapshots})),
    };
    const utilization = {
      api: summary.topologies[topology].apiCpuPercentOfOneCore.median / 400,
      mongo: summary.topologies[topology].mongoCpuPercentOfOneCore.median / 100,
      gateway: summary.topologies[topology].gatewayCpuPercentOfOneCore.median / 25,
      generator: summary.topologies[topology].generatorCpuPercentOfOneCore.median / 100,
    };
    summary.topologies[topology].sampledMedianCpuFractionOfAssignedBudget = utilization;
    summary.topologies[topology].capacityInterpretation = Object.values(utilization).every(value => value < 0.8)
      ? 'No median CPU saturation observed at this rate. A higher-rate experiment is required to establish a bottleneck or maximum capacity.'
      : 'A component uses at least 80% of its assigned CPU budget at the median sample. Investigate it with higher-resolution telemetry before making a capacity claim.';
  }
  assert.equal(images.size, 1, 'Both topologies must use the same immutable image');
  assert.equal(sources.size, 1, 'Both topologies must use the same source content');
  assert.equal(datasets.size, 1, 'Both topologies must use the same dataset manifest');
  assert.equal(rates.size, 1, 'Both topologies must use the same requested arrival rate');
  summary.image = [...images][0]; summary.sourceTreeSha256 = [...sources][0];
  summary.dataset = JSON.parse([...datasets][0]); summary.requestedRate = [...rates][0];
  summary.lowerMedianP95AtTestedRate = summary.topologies.vertical.p95Ms.median < summary.topologies.horizontal.p95Ms.median ? 'vertical' : 'horizontal';
  return summary;
}
