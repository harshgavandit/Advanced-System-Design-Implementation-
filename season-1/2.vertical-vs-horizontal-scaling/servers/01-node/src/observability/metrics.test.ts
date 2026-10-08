import assert from "node:assert/strict";
import test from "node:test";
import { createHttpMetrics } from "./metrics.ts";

test("uses bounded route labels for entity IDs and unknown paths", async () => {
  const metrics = createHttpMetrics("node", { collectRuntimeMetrics: false });

  metrics.observe("GET", "/products/507f1f77bcf86cd799439011")?.finish(200);
  metrics.observe("GET", "/not-a-real-route/private-value")?.finish(404);

  const output = await metrics.render();
  assert.match(output, /route="\/products\/:id"/);
  assert.match(output, /route="__unmatched__"/);
  assert.doesNotMatch(output, /507f1f77bcf86cd799439011|private-value/);
});

test("excludes the metrics scrape from application request metrics", async () => {
  const metrics = createHttpMetrics("node", { collectRuntimeMetrics: false });

  assert.equal(metrics.observe("GET", "/metrics"), null);
  assert.doesNotMatch(await metrics.render(), /app_http_requests_total\{/);
});

test("records a finished request exactly once", async () => {
  const metrics = createHttpMetrics("node", { collectRuntimeMetrics: false });
  const observation = metrics.observe("GET", "/health");

  assert.ok(observation);
  observation.finish(200);
  observation.finish(500);

  const output = await metrics.render();
  assert.match(output, /app_http_requests_total\{implementation="node",method="GET",route="\/health",status_code="200"\} 1/);
  assert.match(output, /app_http_requests_in_flight\{implementation="node"\} 0/);
  assert.doesNotMatch(output, /status_code="500"/);
});
