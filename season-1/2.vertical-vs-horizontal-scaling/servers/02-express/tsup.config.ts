import { defineConfig } from "tsup";

export default defineConfig({
  entry: { migrate: "src/migrate-main.ts", server: "src/server.ts", container: "src/container-main.ts", tracing:"src/observability/tracing.ts", telemetry:"src/observability/edge-main.ts", worker: "src/worker-main.ts", outbox: "src/outbox-main.ts", ingestion: "src/features/ingestion/index.ts", "seed-products": "src/seed/seed-products.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  bundle: true,
});
