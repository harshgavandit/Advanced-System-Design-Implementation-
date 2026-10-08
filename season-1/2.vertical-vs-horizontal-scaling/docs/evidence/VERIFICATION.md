# Verification inventory

Generated at 2026-10-07T14:36:49.025Z. Source fingerprint: `bdb1ea534343daf039ab7f4748ebde90e650aa84a61a1fcfecf0fc62b7ea0b14`. Image: `sha256:8e5fbe174b7d588904d7797e91d13dabb2ffe507361913258aa81d06625755d9`.

This report records actual local artifacts. Passed means artifact-bound success. Historical means another image/source or workload scenario. Unbound means success was recorded without the required fingerprint. Missing and failed gates remain open. CI source checks and mocked Terraform validation are not deployed cloud proof.

| Check | Evidence status | Completed at (UTC) | Raw report SHA-256 |
|---|---|---|---|
| static | passed | 2026-10-07T14:36:47.082Z | 6d5437de08842c50dd2d32b37a5483f6451582b5b0ff937e64cfabda1df652e3 |
| contract | passed | 2026-10-06T18:44:23.369Z | a1445a8d3175a0b71f40fa8522b6b590cb2ad1d8ece9280a4027c5d07de5c8e3 |
| image | passed | 2026-10-06T18:47:10.098Z | 4d2d82a8b948ffc7cebbb76f93909e1c7caf2ca3acbbdf706b4e0a7be884a563 |
| durability | passed | 2026-10-06T18:47:02.781Z | 33fde89133156c658a70bb0523e6a6cfe8d9cc07d83e15148e365ae9cb07cb17 |
| containers | passed | 2026-10-07T14:30:48.688Z | 935808766cae900f211b3b60f22b33b561970a92ae10e5bcaee8cffb0a29a294 |
| drain | passed | 2026-10-07T13:12:08.368Z | 0f211b98176d44b0c2b585b49a34e1c1df79e9b03f12a98ef956616b0b3d6d28 |
| replicas | passed | 2026-10-07T13:13:42.345Z | c007fc515c79c80332d8af36940f52b1ca2993f2b9a02dae58e99b2b8e498096 |
| gateway | passed | 2026-10-07T13:16:44.454Z | 3021b0fa5acc958b4dd70a02f4e0ef6ff3264f6700d39ea07b8bc1b154a22d34 |
| comparison | passed | 2026-10-07T14:27:24.480Z | 270589a8fe8555ec260c57742a5f70fe017e9065daf4058ad2491bc5badaf8a1 |
| database | passed | 2026-10-07T14:35:13.574Z | 8fc919ed873ccc327e918a3f3bd3a9766b1058e738942bffca29ba291b29e0f8 |
| observability | passed | 2026-10-07T13:20:01.444Z | bd869cac4b5bd4eb355b5b2f0c30e7ed4cebaa67f7e4984997d8d37067385adc |
| browser | passed | 2026-10-07T14:35:49.059Z | a497f88341e545c626efc8df2450c135512c307ec29efc00bb9ee02c562f3ceb |
| security | passed | 2026-10-06T18:51:24.391Z | 4c3840e00181f6a3761198f54750092bec1fb0ff77a2a6e92c4e11178e28d2c5 |
| terraform | unbound | 2026-10-06T18:47:31.996Z | b62d5d9a6ea8cd7ee10c34ebd13541163d96688a0e332c0e3edfd856ab6c8934 |
| operations | passed | 2026-10-07T09:07:57.988Z | e8f243b2e281c41ecbe9a0e4dd2750c16c573e9a16c00c4dcf8104a1dfe6970a |
| recovery | passed | 2026-10-07T13:10:51.729Z | cbb90b948fa992a1659b4427b62aae51e5d19f5f134b8fcfbcbab34057c77029 |
| soakRecovery | passed | 2026-10-07T13:10:51.729Z | cbb90b948fa992a1659b4427b62aae51e5d19f5f134b8fcfbcbab34057c77029 |
| rollback | passed | 2026-10-07T09:09:01.279Z | 505d36daeacf3ee1cb25905d0c1a565aaf2eaf7bd9d0df18be962e05a90c6fa8 |
| smoke | passed | 2026-10-07T09:06:51.920Z | 6d9370140cc26584b092b161b1337f4c680312b02703afec3f1fbac023c4a286 |
| support | passed | 2026-10-07T08:17:42.671Z | 09f384977da2d61987945b7b7103ee10b56b9ce2711b828ebca021a6cf39d825 |
| stress | passed | 2026-10-06T21:11:57.738Z | 105895fb48419a1dbfe1cc51afa20d5033eaba3f7d71fbb7e5760179ea7488a1 |
| spike | passed | 2026-10-06T21:18:12.167Z | 36600b6e468d4ce068492c2048d270b457474fb47ae37ae8f26e08de590fbb34 |
| soak | passed | 2026-10-07T13:09:41.931Z | 3ddf7e8c732db15c37c33d5ad10965807b2e413aef43cc1520fcd4e6c12bd5a5 |
| cloud | missing | No completed report | Not recorded |

## Measured mixed workloads

Rates are workload iterations, not HTTP requests. Times below are milliseconds except the measured duration. Failed results remain visible. Authentication/job latency and the full resource/dataset configuration are retained in the manifest and raw reports.

| Profile | Status | Measured seconds | Main iterations / HTTP requests | Catalog p95 / p99 | Write p95 | Accepted jobs / effects | Drops / failed requests |
|---|---|---|---|---|---|---|---|
| smoke | passed | 126.9 | 2401 / 3297 | 3.91 / 5.01 | 115.74 | 48 / 48 | 0 / 0 |
| support | passed | 607.27 | 30001 / 41304 | 6.06 / 9.07 | 133.72 | 600 / 600 | 0 / 0 |
| stress | passed | 487.52 | 38999 / 53567 | 4.63 / 8.32 | 139.19 | 780 / 780 | 0 / 0 |
| spike | passed | 236.56 | 7799 / 10720 | 3.95 / 5.94 | 123.54 | 156 / 156 | 0 / 0 |
| soak | passed | 14407.54 | 720001 / 989230 | 3.31 / 4.69 | 127.92 | 14400 / 14400 | 0 / 0 |

## Retained diagnostic history

These reports are retained for comparison and root-cause evidence. They cannot satisfy current launch gates. Main iteration counts use the filtered counter where available, or total minus the filtered authentication counter; the manifest records which method was used.

| Raw report | Reason retained | SHA-256 |
|---|---|---|
| infra/compose/artifacts/benchmarks/historical-comparison-summary.json | Previous-image equal-resource comparison retained before current-image trials | 4637315d6a7537c1cc5952a767e4726c5b818ef1daf2e7c992fe9a5aa290725b |
| infra/compose/artifacts/historical-phase5-summary.json | Previous-image index/cache capacity summary retained before current-image trials | 1b1033c301f9debd2c8bfe93085c810d11ad045be00a168a3476fb49a722f059 |
| infra/compose/artifacts/failed-capacity-container-verification.json | Capacity wrapper omitted local signing-key context before runtime verification | adc4f9f8aa7422d4788d83e139f267c9afe94103ec1e0163759485666936204a |
| infra/compose/artifacts/operations/load/failed-overlapped-smoke.json | Load overlapped build work | 71d304777d9caf0cd5120bee67c01d604e3be5ef0c5827a0887df1f94f33cc05 |
| infra/compose/artifacts/operations/load/failed-bursty-smoke.json | Earlier grouped write-arrival schedule | 0bbd3851e04518624d78501c3ac6f194c1832750c0c6cef96d2cc06b486bfc22 |
| infra/compose/artifacts/operations/load/failed-frequent-probes-smoke.json | Earlier frequent database shell probes | d51880fd9c88aa89e17dfe41fa8c874b278d8eaa675f792d1a192b8c604093b1 |
| infra/compose/artifacts/operations/load/failed-auth-startup-stress.json | Single authentication VU dropped a startup iteration | 2fc989aac8200bb7f0d0567731cd7482ab82f51c4ac4b30cc0f59c5f5ed4a0eb |
| infra/compose/artifacts/operations/load/failed-auth-refresh-soak.json | Host battery sleep interrupted traffic and refresh cadence; protected-request errors recorded | e9dee179219825d7bedfe7295d91e20674a885702c0cae4622e91deb2930fa61 |
| infra/compose/artifacts/operations/load/failed-soak-live-diagnostics.json | Bounded protected-route status sample from the interrupted soak | 8954f26b01be2cf816fef4acc18c3331bfb9e37d477700e5e220052526ee0dd4 |
| infra/compose/artifacts/operations/load/failed-soak-power-events.json | Windows sleep/wake events identify battery suspension during the run | 438c01b9e67e8e113bced1ce798c7e276498e7367878c0adc175310617f5cb60 |
| infra/compose/artifacts/operations/load/historical-single-probe-support.json | Earlier single-VU authentication scenario | 1cf62c00b93657b005886c84d7e4fb3f4ba2c936d6c34ed4a4e02bac90bbb28e |
| infra/compose/artifacts/operations/load/historical-single-probe-spike.json | Earlier single-VU authentication scenario | a3bc29bb4adef5edda563a336f68f09383b6003e942ef18337147dc9f54a9d99 |
| infra/compose/artifacts/operations/load/interrupted-pre-fixture-fix-soak.json | Interrupted before isolated instance-wide VU fixtures | 5fa96091483d8fa8fba27b6d19e5584ced6ce0336a40ef9027509cf132dcb883 |
| infra/compose/artifacts/operations/load/interrupted-pre-refresh-clock-soak.json | Interrupted before issuance-anchored refresh scheduling | eae60bda803cf8c6efd48ab455d8f22ed311a9ea34e3eb7804f433cd8c0a51e1 |
| infra/compose/artifacts/operations/load/interrupted-host-restart-soak.json | Host/session restart ended the run before full duration or reconciliation | 1d357bb61eb30641677fad0f139d85c526d8c96c8615d8017f04b4462cf427d4 |
| infra/compose/artifacts/failed-runtime-overlay-replica.json | Replica replacement omitted active telemetry overlays | 2f186d489b9d6fb2ffa8764fc127012dbb70043ae635b33a47a248842d314c51 |
| infra/compose/artifacts/failed-telemetry-gateway-retry.json | Gateway retry budget failed during replica restart | 455e5eca05469297341fee0b57a4ade65ff170b64049e4dcfb5310ee3b1300cc |
| infra/compose/artifacts/operations/recovery/failed-support-rollback-recovery.json | Support setup failed in local proxy rollback verification before workload | 9bf35082abbb4fe862ecb1ae4067071d8356c3b0c2bff20f0e2ed0bd070e579f |

## Launch decision

Not approved for a sustained production claim.

- HTTPS cloud staging acceptance is missing
- A full 30-day production SLO window has not been observed

Raw report paths and content hashes are listed in verification-manifest.json. Credentials, session fixtures, backup keys, and scan caches are intentionally excluded. Regenerate after each test with `node scripts/operations/evidence.mjs`.
