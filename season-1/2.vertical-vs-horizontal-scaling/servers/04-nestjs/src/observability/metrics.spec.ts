import { createHttpMetrics } from "./metrics.js";

describe("HTTP metrics", () => {
  it("uses bounded route labels for entity IDs and unknown paths", async () => {
    const metrics = createHttpMetrics("nestjs", { collectRuntimeMetrics: false });
    metrics.observe("GET", "/products/507f1f77bcf86cd799439011")?.finish(200);
    metrics.observe("GET", "/not-a-real-route/private-value")?.finish(404);
    const output = await metrics.render();
    expect(output).toMatch(/route="\/products\/:id"/);
    expect(output).toMatch(/route="__unmatched__"/);
    expect(output).not.toMatch(/507f1f77bcf86cd799439011|private-value/);
  });

  it("excludes the metrics scrape from application request metrics", async () => {
    const metrics = createHttpMetrics("nestjs", { collectRuntimeMetrics: false });
    expect(metrics.observe("GET", "/metrics")).toBeNull();
    expect(await metrics.render()).not.toMatch(/app_http_requests_total\{/);
  });

  it("records a finished request exactly once", async () => {
    const metrics = createHttpMetrics("nestjs", { collectRuntimeMetrics: false });
    const observation = metrics.observe("GET", "/health");
    expect(observation).not.toBeNull();
    observation?.finish(200);
    observation?.finish(500);
    const output = await metrics.render();
    expect(output).toMatch(/app_http_requests_total\{implementation="nestjs",method="GET",route="\/health",status_code="200"\} 1/);
    expect(output).toMatch(/app_http_requests_in_flight\{implementation="nestjs"\} 0/);
    expect(output).not.toMatch(/status_code="500"/);
  });
});
