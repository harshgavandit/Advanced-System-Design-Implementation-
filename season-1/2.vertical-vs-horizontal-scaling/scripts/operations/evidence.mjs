import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evidenceStatus, launchDecision} from './evidence-policy.mjs';

const topic = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const folder = resolve(topic, 'infra/compose/artifacts');
const output = resolve(topic, 'docs/evidence');
const source = spawnSync(process.execPath, [resolve(topic, 'scripts/local/source-hash.mjs')], {encoding: 'utf8'});
if (source.status !== 0) throw Error('Application source fingerprint failed');
const sourceHash = source.stdout.trim();
// The original HTTP suite fingerprints only src/, with a distinct algorithm.
// Compare it to that scope instead of falsely labelling fresh contracts stale.
const contractHash = createHash('sha256');
async function contractSource(path, prefix = '') {
  const entries = await readdir(path, {withFileTypes: true});
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await contractSource(resolve(path, entry.name), name + '/');
    else { contractHash.update(name + '\0'); contractHash.update(await readFile(resolve(path, entry.name))); }
  }
}
await contractSource(resolve(topic, 'servers/02-express/src'));
const contractSourceHash = contractHash.digest('hex');
const scenarioHash = createHash('sha256');
for (const name of ['mixed.js', 'workload-mix.js', 'vu-fixture.js', 'workload-duration.js', 'json-equal.js', 'mixed-policy.mjs']) {
  scenarioHash.update(name + '\0');scenarioHash.update(await readFile(resolve(topic, 'bench/scenarios', name)));
}
const scenarioSha256 = scenarioHash.digest('hex');
const definitions = {
  static: 'ci/ci-static.json', contract: 'tests/phase0/artifacts/contract-report-express.json',
  image: 'ci/image-identity.json', durability: 'ingestion/durability.json',
  containers: 'container-verification.json', drain: 'container-drill.json', replicas: 'replica-drill.json',
  gateway: 'gateway-failover.json',
  comparison: 'benchmarks/comparison-summary.json', database: 'phase5-summary.json',
  observability: 'phase6-observability.json', browser: 'browser-verification.json',
  security: 'ci/security-summary.json', terraform: 'ci/terraform-verification.json',
  operations: 'ci/operations-summary.json', recovery: 'operations/recovery/recovery.json',
  soakRecovery: 'operations/recovery/recovery-soak.json',
  rollback: 'operations/rollback/rollback.json', smoke: 'operations/load/smoke.json',
  support: 'operations/load/support.json', stress: 'operations/load/stress.json',
  spike: 'operations/load/spike.json', soak: 'operations/load/soak.json', cloud: 'ci/staging.json',
};
const records = {}, reports = {};
for (const [name, path] of Object.entries(definitions)) {
  const location = name === 'contract' ? resolve(topic, 'tests/phase0/artifacts/contract-report-express.json') : resolve(folder, path);
  try {
    const bytes = await readFile(location);
    const report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    reports[name] = report;
    records[name] = {path: name === 'contract' ? 'tests/phase0/artifacts/contract-report-express.json' : 'infra/compose/artifacts/' + path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), finishedAt: report.finishedAt ?? report.completedAt ?? report.at ?? report.createdAt, sourceTreeSha256: report.sourceTreeSha256, image: report.imageId ?? report.image};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    records[name] = {path: 'infra/compose/artifacts/' + path};
  }
}
const identity = reports.image;
for (const [name, record] of Object.entries(records)) {
  record.fingerprintScope = name === 'contract' ? 'server-src' : 'application-build';
  record.status = name === 'image' && identity?.durabilityPassed === true ? (identity.sourceTreeSha256 === sourceHash ? 'passed' : 'historical') : evidenceStatus(reports[name], {sourceHash: name === 'contract' ? contractSourceHash : sourceHash, imageId: identity?.imageId, scenarioSha256: ['smoke','support','stress','spike','soak'].includes(name) ? scenarioSha256 : undefined});
}
// Only source/image-bound passing evidence can contribute to a launch decision.
const launchInputs = Object.fromEntries(['cloud', 'support', 'soak', 'recovery', 'rollback', 'security'].map(name => [name, records[name].status === 'passed' ? reports[name] : null]));
const report = {schemaVersion: 1, generatedAt: new Date().toISOString(), sourceTreeSha256: sourceHash, scenarioSha256, imageId: identity?.imageId, cloudConfigured: reports.cloud?.cloud === true, records, launch: launchDecision(launchInputs)};
report.workloads=Object.fromEntries(['smoke','support','stress','spike','soak'].map(name=>{
  const value=reports[name],metrics=value?.result?.metrics;
  const direct=metrics?.['iterations{scenario:mixed}']?.count,authentication=metrics?.['iterations{scenario:authentication}']?.count,total=metrics?.iterations?.count;
  const main=direct??(Number.isFinite(total)&&Number.isFinite(authentication)?total-authentication:undefined);
  return [name,{status:records[name].status,measuredSeconds:value?.measuredSeconds,iterations:total,mixedIterations:main,mixedIterationsMethod:Number.isFinite(direct)?'filtered counter':Number.isFinite(main)?'total minus filtered authentication counter':undefined,authenticationIterations:authentication,httpRequests:metrics?.http_reqs?.count,failedRequests:metrics?.http_req_failed?.passes,droppedIterations:metrics?.dropped_iterations?.count??(metrics?0:undefined),catalogP95Ms:metrics?.['http_req_duration{kind:catalog}']?.['p(95)'],catalogP99Ms:metrics?.['http_req_duration{kind:catalog}']?.['p(99)'],writeP95Ms:metrics?.['http_req_duration{kind:write}']?.['p(95)'],authenticationP95Ms:metrics?.['http_req_duration{kind:authentication}']?.['p(95)'],ingestionP95Ms:metrics?.ingestion_completion_ms?.['p(95)'],acknowledgedJobs:value?.reconciliation?.acknowledged,productEffects:value?.reconciliation?.productEffects}];
}));
// Explicit allowlist: preserve diagnostic history without walking key/session folders.
report.history=[];
for(const [path,reason] of [
  ['benchmarks/historical-comparison-summary.json','Previous-image equal-resource comparison retained before current-image trials'],
  ['historical-phase5-summary.json','Previous-image index/cache capacity summary retained before current-image trials'],
  ['failed-capacity-container-verification.json','Capacity wrapper omitted local signing-key context before runtime verification'],
  ['operations/load/failed-overlapped-smoke.json','Load overlapped build work'],
  ['operations/load/failed-bursty-smoke.json','Earlier grouped write-arrival schedule'],
  ['operations/load/failed-frequent-probes-smoke.json','Earlier frequent database shell probes'],
  ['operations/load/failed-auth-startup-stress.json','Single authentication VU dropped a startup iteration'],
  ['operations/load/failed-auth-refresh-soak.json','Host battery sleep interrupted traffic and refresh cadence; protected-request errors recorded'],
  ['operations/load/failed-soak-live-diagnostics.json','Bounded protected-route status sample from the interrupted soak'],
  ['operations/load/failed-soak-power-events.json','Windows sleep/wake events identify battery suspension during the run'],
  ['operations/load/historical-single-probe-support.json','Earlier single-VU authentication scenario'],
  ['operations/load/historical-single-probe-spike.json','Earlier single-VU authentication scenario'],
  ['operations/load/interrupted-pre-fixture-fix-soak.json','Interrupted before isolated instance-wide VU fixtures'],
  ['operations/load/interrupted-pre-refresh-clock-soak.json','Interrupted before issuance-anchored refresh scheduling'],
  ['operations/load/interrupted-host-restart-soak.json','Host/session restart ended the run before full duration or reconciliation'],
  ['failed-runtime-overlay-replica.json','Replica replacement omitted active telemetry overlays'],
  ['failed-telemetry-gateway-retry.json','Gateway retry budget failed during replica restart'],
  ['operations/recovery/failed-support-rollback-recovery.json','Support setup failed in local proxy rollback verification before workload'],
]){
  try{
    const bytes=await readFile(resolve(folder,path));
    const value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    report.history.push({path:'infra/compose/artifacts/'+path,reason,eligibleForLaunch:false,recordedPassed:value.passed===true,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
  }catch(error){if(error.code!=='ENOENT')throw error;}
}
await mkdir(output, {recursive: true});
await writeFile(resolve(output, 'verification-manifest.json'), JSON.stringify(report, null, 2) + '\n');
const rows = Object.entries(records).map(([name, record]) => `| ${name} | ${record.status} | ${record.finishedAt ?? 'No completed report'} | ${record.sha256 ?? 'Not recorded'} |`);
const show=value=>Number.isFinite(value)?Number(value.toFixed(2)):'Not recorded';
const workloadRows=Object.entries(report.workloads).map(([name,value])=>`| ${name} | ${value.status} | ${show(value.measuredSeconds)} | ${show(value.mixedIterations)} / ${show(value.httpRequests)} | ${show(value.catalogP95Ms)} / ${show(value.catalogP99Ms)} | ${show(value.writeP95Ms)} | ${show(value.acknowledgedJobs)} / ${show(value.productEffects)} | ${show(value.droppedIterations)} / ${show(value.failedRequests)} |`);
const historyRows=report.history.map(value=>`| ${value.path} | ${value.reason} | ${value.sha256} |`);
await writeFile(resolve(output, 'VERIFICATION.md'), [
  '# Verification inventory', '',
  `Generated at ${report.generatedAt}. Source fingerprint: \`${sourceHash}\`. Image: \`${report.imageId ?? 'Not built'}\`.`, '',
  'This report records actual local artifacts. Passed means artifact-bound success. Historical means another image/source or workload scenario. Unbound means success was recorded without the required fingerprint. Missing and failed gates remain open. CI source checks and mocked Terraform validation are not deployed cloud proof.', '',
  '| Check | Evidence status | Completed at (UTC) | Raw report SHA-256 |', '|---|---|---|---|', ...rows, '',
  '## Measured mixed workloads', '',
  'Rates are workload iterations, not HTTP requests. Times below are milliseconds except the measured duration. Failed results remain visible. Authentication/job latency and the full resource/dataset configuration are retained in the manifest and raw reports.', '',
  '| Profile | Status | Measured seconds | Main iterations / HTTP requests | Catalog p95 / p99 | Write p95 | Accepted jobs / effects | Drops / failed requests |',
  '|---|---|---|---|---|---|---|---|', ...workloadRows, '',
  '## Retained diagnostic history', '',
  'These reports are retained for comparison and root-cause evidence. They cannot satisfy current launch gates. Main iteration counts use the filtered counter where available, or total minus the filtered authentication counter; the manifest records which method was used.', '',
  '| Raw report | Reason retained | SHA-256 |', '|---|---|---|', ...historyRows, '',
  '## Launch decision', '', `${report.launch.approved ? 'Approved' : 'Not approved'} for a sustained production claim.`, '',
  ...report.launch.blockers.map(item => '- ' + item), '',
  'Raw report paths and content hashes are listed in verification-manifest.json. Credentials, session fixtures, backup keys, and scan caches are intentionally excluded. Regenerate after each test with `node scripts/operations/evidence.mjs`.', '',
].join('\n'));
console.log('EVIDENCE_INVENTORY_WRITTEN launchApproved=' + report.launch.approved);
