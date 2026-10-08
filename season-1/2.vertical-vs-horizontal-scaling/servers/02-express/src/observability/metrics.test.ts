import assert from "node:assert/strict";
import test from "node:test";
import { createHttpMetrics } from "./metrics.ts";

test("uses bounded route labels for entity IDs and unknown paths", async () => {
  const metrics = createHttpMetrics("express", { collectRuntimeMetrics: false });
  metrics.observe("GET", "/products/507f1f77bcf86cd799439011")?.finish(200);
  metrics.observe("GET", "/not-a-real-route/private-value")?.finish(404);
  const output = await metrics.render();
  assert.match(output, /route="\/products\/:id"/);
  assert.match(output, /route="__unmatched__"/);
  assert.doesNotMatch(output, /507f1f77bcf86cd799439011|private-value/);
});

test("excludes the metrics scrape from application request metrics", async () => {
  const metrics = createHttpMetrics("express", { collectRuntimeMetrics: false });
  assert.equal(metrics.observe("GET", "/metrics"), null);
  assert.doesNotMatch(await metrics.render(), /app_http_requests_total\{/);
});

test("records a finished request exactly once", async () => {
  const metrics = createHttpMetrics("express", { collectRuntimeMetrics: false });
  const observation = metrics.observe("GET", "/health");
  assert.ok(observation);
  observation.finish(200);
  observation.finish(500);
  const entries = await metrics.registry.getMetricsAsJSON();
  const requests = entries.find(entry => entry.name === "app_http_requests_total")!;
  assert.equal(requests.values.length, 1);
  assert.equal(requests.values[0].value, 1);
  assert.equal(requests.values[0].labels.status_code, "200");
  assert.equal(requests.values[0].labels.route, "/health");
  assert.equal(entries.find(entry => entry.name === "app_http_requests_in_flight")!.values[0].value, 0);
});

test('normalizes supported aliases and keeps methods and job routes bounded',async()=>{
  const metrics=createHttpMetrics('express',{collectRuntimeMetrics:false});
  assert.equal(metrics.observe('GET','/METRICS/'),null);
  metrics.observe('GET','/INGESTION-JOBS/507f1f77bcf86cd799439011/')?.finish(200);
  metrics.observe('POST','/ingestion-jobs/507f1f77bcf86cd799439011/redrive')?.finish(202);
  metrics.observe('CUSTOM_METHOD_1','/products')?.finish(404);
  const output=await metrics.render();
  assert.match(output,/route="\/ingestion-jobs\/:id"/);
  assert.match(output,/route="\/ingestion-jobs\/:id\/redrive"/);
  assert.match(output,/method="OTHER"/);
  assert.doesNotMatch(output,/507f1f77bcf86cd799439011|CUSTOM_METHOD_1/);
});

test('records durable completion latency separately from delivery attempts without identifiers',async()=>{
  const metrics=createHttpMetrics('express',{collectRuntimeMetrics:false});
  metrics.ingestionCompletion(12.5);
  metrics.ingestionAttempt('retry',0.2);
  const rows=await metrics.registry.getMetricsAsJSON();
  const completion=rows.find(row=>row.name==='app_ingestion_completion_seconds')!;
  assert.equal(completion.values.find(value=>value.metricName==='app_ingestion_completion_seconds_count')!.value,1);
  assert.equal(completion.values.find(value=>value.metricName==='app_ingestion_completion_seconds_sum')!.value,12.5);
  assert.ok(!JSON.stringify(completion).includes('jobId'));
});
