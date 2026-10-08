import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { acquireRunLock, assertDatabaseOwner } from './ownership.mjs';
import { serverRequire, yaml, SwaggerParser } from './dependencies.mjs';
import { assertSchema, selectOperations } from './schema.mjs';
import { TEST_URI, assertTestTarget } from './target.mjs';
import { generateProducts, createManifest } from '../../bench/fixtures/generate.mjs';
import {applyProductionOverlay} from '../../contracts/production-overlay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const topic = resolve(here, '../..');
const implementationArg = process.argv.find(arg => arg.startsWith('--implementation='));
const implementation = implementationArg?.split('=')[1] ?? 'express';
const serverNames = { node:'01-node', express:'02-express', fastify:'03-fastify', nestjs:'04-nestjs' };
if (!serverNames[implementation]) throw new Error(`Unknown implementation: ${implementation}`);
const serverDir = resolve(topic, 'servers', serverNames[implementation]);
const artifacts = resolve(here, 'artifacts');
const args = new Set(process.argv.slice(2).filter(arg => arg !== implementationArg));
for (const arg of args) if (!['--reset-test-db', '--load', '--proxy'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
assertTestTarget(TEST_URI);
await mkdir(artifacts, { recursive: true });
const spec = yaml.load(await readFile(resolve(topic, 'contracts/openapi.yaml'), 'utf8'));
const canonical = implementation === 'express';
const policy = JSON.parse(await readFile(resolve(topic, 'contracts/express-production.json'), 'utf8'));
const matrix = JSON.parse(await readFile(resolve(topic, 'contracts/capabilities.json'), 'utf8'));
if (canonical) {
  spec.info.version = policy.version;
  for (const methods of Object.values(spec.paths)) for (const op of Object.values(methods)) {
    if (!op.operationId) continue;
    for (const status of policy.errorStatuses) op.responses[status] ??= { description: 'Security or availability rejection', content: { 'application/json': { schema: { type:'object',required:['error'],properties:{error:{type:'string'}} } } } };
    if (policy.adminOperations.includes(op.operationId)) op.security = [{ bearerAuth: [] }];
    if (op.operationId === 'refresh') {
      let schema = op.responses['200'].content['application/json'].schema;
      if (schema.$ref) schema = spec.components.schemas[schema.$ref.split('/').at(-1)];
      schema.required = policy.refreshRequiredFields;
      schema.properties.refreshToken = {type:'string'};
    }
  }
}
if(canonical) applyProductionOverlay(spec,policy,matrix);
const resolvedSpec = await SwaggerParser.validate(structuredClone(spec));
const capabilities = selectOperations(spec, matrix, implementation);
const products = generateProducts({ count: 10000, seed: 42 });
const manifest = createManifest(products, 42);
const mongoose = serverRequire('mongoose');
const client = new mongoose.mongo.MongoClient(TEST_URI, { serverSelectionTimeoutMS: 5000 });
let child;
let childExited;
let serverOutput = '';
let loadGateway;
let adminToken;
const results = [];
const gaps = [];
const covered = new Set();
const report = {
  startedAt: new Date().toISOString(), implementation, contractVersion: spec.info.version,
  sourceSha: spawnSync('git', ['-c', `safe.directory=${resolve(topic, '../..').replaceAll('\\', '/')}`, 'rev-parse', 'HEAD'], { cwd: topic, encoding: 'utf8' }).stdout.trim(),
  dataset: manifest, runtime: { node: process.version, platform: os.platform(), arch: os.arch(), hostLogicalCPUs: os.cpus().length, hostMemoryBytes: os.totalmem() },
  environment: { api: 'http://127.0.0.1:5102', apiResourceLimits: 'host process, no CPU/memory cap', workers: 1, mongo: 'isolated single-node replica set, 1 CPU / 768 MiB', redis: 'not connected; Mongo session fallback', cache: 'direct API, no proxy cache', compression: 'identity' },
  results, gaps, productionReady: false,
};

const operations = new Map(Object.entries(resolvedSpec.paths).flatMap(([path, methods]) => Object.entries(methods).filter(([, op]) => op.operationId).map(([method, op]) => [op.operationId, { path, method, ...op }])));
async function sourceHash(directory) {
  const hash = createHash('sha256');
  async function walk(path, relative = '') {
    for (const name of (await readdir(path)).sort()) {
      const full = resolve(path, name);
      const entries = await readdir(path, { withFileTypes:true });
      const entry = entries.find(e => e.name === name);
      if (entry.isDirectory()) await walk(full, `${relative}${name}/`);
      else { hash.update(`${relative}${name}\0`); hash.update(await readFile(full)); }
    }
  }
  await walk(directory);
  return hash.digest('hex');
}
report.sourceTreeSha256 = await sourceHash(resolve(serverDir, 'src'));
async function request(operationId, { id, query = '', body, token, key, expected = 200 } = {}) {
  if (canonical && token === undefined && policy.adminOperations.includes(operationId)) token = adminToken;
  assert.ok(capabilities.supported.includes(operationId), `Unsupported operation: ${operationId}`);
  const op = operations.get(operationId);
  const path = op.path.replace('{id}', encodeURIComponent(id ?? '')) + query;
  const headers = { 'accept-encoding': 'identity' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if(canonical && operationId==='ingestProduct') headers['idempotency-key']='phase0-contract-ingest';
  if(canonical && policy.mutationOperations?.includes(operationId) && key!==null) headers['idempotency-key']=key??randomBytes(16).toString('hex');
  const start = performance.now();
  const response = await fetch('http://127.0.0.1:5102' + path, { method: op.method.toUpperCase(), headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  const contentType = operationId === 'getMetrics' ? 'text/plain' : 'application/json';
  const value = contentType === 'text/plain' ? text : JSON.parse(text);
  assert.ok((Array.isArray(expected)?expected:[expected]).includes(response.status), `${operationId}: expected ${expected}, got ${response.status}${response.status >= 400 ? ', error=' + String(value.error ?? value.message) : ''}`);
  assert.ok(response.headers.get('content-type')?.includes(contentType), `${operationId}: content type`);
  const schema = op.responses[response.status]?.content?.[contentType]?.schema;
  assert.ok(schema, `${operationId}: undocumented status ${response.status}`);
  assertSchema(schema, value);
  covered.add(operationId);
  results.push({ operationId, method: op.method, path: op.path, status: response.status, durationMs: Math.round((performance.now() - start) * 100) / 100, passed: true });
  return value;
}

function resourceSample() {
  return new Promise((resolveSample, reject) => {
    const timeout = setTimeout(() => { child.off('message', listener); reject(new Error('Resource sample timed out')); }, 5000);
    const listener = message => { if (!message.resources) return; clearTimeout(timeout); child.off('message', listener); resolveSample(message.resources); };
    child.on('message', listener);
    child.send('resources');
  });
}

function dependencyCommand(command, payload=command) {
  return new Promise((resolveCommand, reject) => {
    const listener = message => { if (message.dependency !== command) return; clearTimeout(timeout); child.off('message',listener); resolveCommand(message.value); };
    const timeout=setTimeout(()=>{child.off('message',listener);reject(new Error(`Dependency command timed out: ${command}`));},10000);
    child.on('message',listener);
    child.send(payload);
  });
}

const releaseLock = await acquireRunLock(resolve(here, 'run.lock'));
try {
  const portProbe = createServer();
  await new Promise((ready, reject) => { portProbe.once('error', reject); portProbe.listen(5102, '127.0.0.1', ready); });
  await new Promise(r => portProbe.close(r));
  await client.connect();
  const db = client.db(assertTestTarget(TEST_URI));
  const collections = await db.listCollections().toArray();
  assertDatabaseOwner(collections, await db.collection('_phase0_owner').findOne({ _id: 'phase0-contract-tests' }));
  if (collections.length && !args.has('--reset-test-db')) throw new Error('Isolated test DB exists. Rerun with --reset-test-db to reset only phase0_contract_test.');
  if (collections.length) await db.dropDatabase();
  await db.collection('_phase0_owner').insertOne({ _id: 'phase0-contract-tests', version: 1 });
  await db.collection('products').insertMany(products.map(p => ({ ...p, _id: new mongoose.Types.ObjectId(p._id), createdAt: new Date(p.createdAt), updatedAt: new Date(p.updatedAt) })));
  assert.equal(await db.collection('products').countDocuments(), manifest.count);
  await writeFile(resolve(artifacts, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const { build } = serverRequire('tsup');
  const serverPackage = JSON.parse(await readFile(resolve(serverDir, 'package.json'), 'utf8'));
  const entry = implementation === 'express' ? 'fixture-server.ts' : `fixture-${implementation}.ts`;
  await build({ entry: { 'fixture-server': resolve(here, entry) }, outDir: resolve(serverDir, 'dist/phase0'), outExtension:()=>({js:'.js'}), config: false, tsconfig: resolve(serverDir, 'tsconfig.json'), format: ['esm'], target: 'node22', platform: 'node', external: Object.keys(serverPackage.dependencies), silent: true });
  child = fork(resolve(serverDir, 'dist/phase0/fixture-server.js'), [], { cwd: here, silent: true, env: {
    ...process.env, NODE_ENV: 'test', MONGO_URI: TEST_URI, PORT: '5102', LOG_LEVEL: 'error', ENABLE_ZSTD: 'false',
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    JWT_ACCESS_EXPIRES_IN: '5m', JWT_REFRESH_EXPIRES_IN: '1h',
    REDIS_URL: 'redis://127.0.0.1:28028',
    PUBLIC_CATALOG_CACHE: canonical?'true':'false',
    CACHE_NAMESPACE: 'phase0-catalog',
  } });
  childExited = once(child, 'exit');
  child.stdout.on('data', chunk => { serverOutput += chunk; });
  child.stderr.on('data', chunk => { serverOutput += chunk; });
  await new Promise((ready, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server startup timeout')), 20000);
    child.once('error', err => { clearTimeout(timeout); reject(err); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Test server exited before readiness (${code})`)); });
    child.on('message', message => { if (message.ready) { clearTimeout(timeout); ready(); } });
  });
  await request('getHealth');
  if (canonical) {
    const admin = await request('signup', {body:{name:'fixture-admin',email:'fixture-admin@example.invalid',password:'Synthetic-test-password-42',role:'admin'},expected:201});
    assert.equal((await db.collection('users').findOne({_id:new mongoose.Types.ObjectId(admin.user.id)})).role, 'user', 'Signup cannot self-grant admin');
    await request('createProduct', {body:{},token:admin.accessToken,expected:403});
    await request('createProduct', {body:{},token:null,expected:401});
    await db.collection('users').updateOne({_id:new mongoose.Types.ObjectId(admin.user.id)},{$set:{role:'admin'}});
    adminToken = admin.accessToken;
  }
  assert.equal((await request('getReady')).writes, true);
  assert.match(await request('getMetrics'), /app_http_requests_total/);
  const page = await request('listProducts', { query: '?page=1&limit=20' });
  assert.equal(page.items.length, 20);
  assert.equal(page.totalItems, 10000);
  assert.equal(page.items[0]._id, products[0]._id);
  const cursorPage = await request('listProducts', { query: '?limit=20' });
  const next = await request('listProducts', { query: `?cursor=${cursorPage.nextCursor}&limit=20` });
  assert.equal(next.items[0]._id, products[20]._id);
  assert.ok(!('totalItems' in next));
  assert.equal((await request('listProducts', { query: '?page=2&cursor=' + products[99]._id + '&limit=20' })).items[0]._id, products[20]._id);
  assert.equal((await request('listProducts', { query: '?page=1&limit=500' })).items.length, 100);
  assert.equal((await request('listProducts', { query: '?page=1&limit=0' })).limit, 20);
  assert.deepEqual((await request('listProducts', { query: '?category=missing-fixture-category' })).items, []);
  const filtered = await request('listProducts', { query: '?page=1&category=home' });
  assert.ok(filtered.items.every(x => x.category === 'home'));
  if (canonical) { assert.equal(filtered.totalItems, manifest.categories.home); assert.equal(filtered.totalItemsExact, true); assert.equal(page.totalItemsExact, false); }
  if (filtered.totalItems !== manifest.categories.home) gaps.push({ id: 'filtered-total', expected: manifest.categories.home, actual: filtered.totalItems, evidence: 'HTTP response compared with fixture manifest', phase: 1 });
  await request('getProduct', { id: products[0]._id });
  await request('getProduct', { id: '000000000000000000000000', expected: 404 });
  await request('getProduct', { id: 'invalid', expected: 400 });
  await request('createProduct', { body: {}, expected: 400 });
  const payload = { name: 'Contract product', description: 'Synthetic', price: 12.5, stock: 5, category: 'test-only', imageUrl: 'https://fixtures.example.invalid/one.png' };
  const created = await request('createProduct', { body: payload, expected: 201 });
  if (!canonical) gaps.push({ id: 'public-product-mutation', actual: 201, expectedProduction: 401, evidence: 'Unauthenticated POST /products', phase: 1 });
  assert.equal((await request('updateProduct', { id: created._id, body: { price: 15 } })).price, 15);
  await request('signup', { body: {}, expected: 400 });
  const signup = name => request('signup', { body: { name, email: `${name}@example.invalid`, password: 'Synthetic-test-password-42' }, expected: 201 });
  const a = await signup('phase0-a');
  const b = await signup('phase0-b');
  await request('signup', { body: { name: 'duplicate', email: 'phase0-a@example.invalid', password: 'Synthetic-test-password-42' }, expected: 409 });
  const loggedIn = await request('login', { body: { email: 'phase0-a@example.invalid', password: 'Synthetic-test-password-42' } });
  await request('login', { body: { email: 'phase0-a@example.invalid', password: 'wrong-password' }, expected: 401 });
  const refreshed = await request('refresh', { body: { refreshToken: loggedIn.refreshToken } });
  const profile = await request('getProfile', { token: refreshed.accessToken });
  assert.equal(profile._id, a.user.id);
  assert.ok(!('passwordHash' in profile));
  await request('getProfile', { expected: 401 });
  assert.equal((await request('updateProfile', { token: a.accessToken, body: { bio: 'contract-check' } })).bio, 'contract-check');
  await request('listCart', { expected: 401 });
  await request('listWishlist', { expected: 401 });
  const cart = await request('addCart', { token: a.accessToken, body: { productId: created._id, qty: 2 }, expected: 201 });
  assert.equal((await request('addCart', { token: a.accessToken, body: { productId: created._id, qty: 3 } })).qty, 5);
  assert.equal((await request('listCart', { token: a.accessToken })).total, 75);
  await request('getCart', { id: cart._id, token: a.accessToken });
  await request('getCart', { id: cart._id, token: b.accessToken, expected: 404 });
  await request('updateCart', { id: cart._id, token: b.accessToken, body: { qty: 9 }, expected: 404 });
  await request('adjustCart', { id: cart._id, token: b.accessToken, body: { delta: 1 }, expected: 404 });
  assert.equal((await request('updateCart', { id: cart._id, token: a.accessToken, body: { qty: 2 } })).qty, 2);
  assert.equal((await request('adjustCart', { id: cart._id, token: a.accessToken, body: { delta: 1 } })).qty, 3);
  await request('adjustCart', { id: cart._id, token: a.accessToken, body: { delta: 0 }, expected: 400 });
  await request('deleteCart', { id: cart._id, token: b.accessToken, expected: 404 });
  await request('deleteCart', { id: cart._id, token: a.accessToken });
  assert.equal((await request('listCart', { token: a.accessToken })).total, 0);
  const toDecrement = await request('addCart', {token:a.accessToken, body:{productId:created._id,qty:1},expected:201});
  assert.ok((await request('adjustCart', {id:toDecrement._id,token:a.accessToken,body:{delta:-1}})).deleted);
  await request('getCart', {id:toDecrement._id,token:a.accessToken,expected:404});
  const wish = await request('addWishlist', { token: a.accessToken, body: { productId: created._id }, expected: 201 });
  await request('addWishlist', { token: a.accessToken, body: { productId: created._id }, expected: 409 });
  assert.equal((await request('listWishlist', { token: a.accessToken })).items.length, 1);
  assert.equal((await request('listWishlist', { token: b.accessToken })).items.length, 0);
  await request('getWishlist', { id: wish._id, token: a.accessToken });
  await request('getWishlist', { id: wish._id, token: b.accessToken, expected: 404 });
  await request('deleteWishlist', { id: wish._id, token: b.accessToken, expected: 404 });
  await request('deleteWishlist', { id: wish._id, token: a.accessToken });
  await request('getWishlist', { id: wish._id, token: a.accessToken, expected: 404 });
  await request('logout', { token: a.accessToken });
  await request('getProfile', { token: a.accessToken, expected: 401 });
  await request('refresh', { body: { refreshToken: a.refreshToken }, expected: 401 });
  await request('deleteProduct', { id: created._id });
  await request('getProduct', { id: created._id, expected: 404 });
  const acceptedIngest=await request('ingestProduct', { body: { ...payload, name: 'phase0-ingest' }, expected: 202 });
  if(canonical) {
    await request('getIngestionJob',{id:acceptedIngest.jobId,token:adminToken});
    await dependencyCommand(`ingestion:${acceptedIngest.jobId}`,{processIngestion:acceptedIngest.jobId});
    assert.equal((await request('getIngestionJob',{id:acceptedIngest.jobId,token:adminToken})).status,'succeeded');
    assert.equal((await request('redriveIngestionJob',{id:acceptedIngest.jobId,expected:202})).status,'succeeded');
  }
  let ingested;
  for (let attempt = 0; attempt < 30; attempt++) {
    ingested = await db.collection('products').findOne({ name: 'phase0-ingest' });
    if (ingested) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ingested, 'Accepted ingest must flush during this healthy-path test');
  assert.equal((await request('getIngestStats')).flushed, 1);
  await request('deleteProduct', { id: String(ingested._id) });
  if (canonical) {
    if (args.has('--proxy')) {
      const { verifyProxy } = await import('../security/proxy.mjs');
      report.proxy = await verifyProxy({topic,artifacts,tokens:[refreshed.accessToken,b.accessToken]});
    }
    const {verifyDatabaseCache}=await import('../integration/database-cache.mjs');
    report.databaseCache=await verifyDatabaseCache({db,request,dependencyCommand});
    const {measureIndexCost}=await import('../integration/index-cost.mjs');
    report.indexCost=await measureIndexCost(db);
    const { verifySecurity } = await import('../security/verify.mjs');
    report.security = await verifySecurity({ db, client, request, adminToken, productId: products[0]._id, serverRequire, dependencyCommand });
  }
  assert.equal(await db.collection('products').countDocuments(), manifest.count);
  assert.deepEqual([...covered].sort(), [...capabilities.supported].sort(), 'Every advertised operation must execute');
  if(!canonical) gaps.push({ id: 'ingest-durability', evidence: 'Comparison implementation retains its process-local baseline; canonical Express uses durable job/outbox.', phase: 4 });
  report.supportedOperationsExecuted = [...covered].sort();
  report.unsupported = capabilities.unsupported;
  report.contractPassed = true;
  console.log(`CONTRACT_PASS requests=${results.length} operations=${covered.size} known_gaps=${gaps.length}`);
  if (args.has('--load')) {
    assert.equal(implementation, 'express', 'Resource-sampled load baseline currently targets canonical Express');
    const gateToken = randomBytes(32).toString('hex');
    loadGateway = createServer((req, res) => {
      if (req.headers['x-phase0-key'] !== gateToken || req.method !== 'GET' || req.url !== '/products?page=1&limit=20') { res.writeHead(404); res.end(); return; }
      const upstream = httpRequest('http://127.0.0.1:5102' + req.url, { headers: { 'accept-encoding':'identity' } }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.end();
    });
    await new Promise((ready, reject) => { loadGateway.once('error', reject); loadGateway.listen(5103, '0.0.0.0', ready); });
    report.environment.loadIngress = 'Authenticated read-only test gateway :5103 to loopback API :5102; k6 latency includes this hop';
    const before = await resourceSample();
    const started = performance.now();
    const load = spawn('docker', ['run', '--rm', '--cpus=1', '--memory=512m', '-v', `${resolve(topic, 'bench/k6')}:/scripts:ro`, '-v', `${artifacts}:/results`, '-e', 'URL=http://host.docker.internal:5103/products?page=1&limit=20', '-e', 'PHASE0_GATE_TOKEN', '-e', 'RATE=20', '-e', 'DURATION=2m', 'grafana/k6:latest', 'run', '--summary-export=/results/k6-baseline.json', '/scripts/phase0-baseline.js'], { stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PHASE0_GATE_TOKEN:gateToken} });
    let output = '';
    load.stdout.on('data', chunk => { output += chunk; });
    load.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(load, 'exit');
    await writeFile(resolve(artifacts, 'k6-output.txt'), output);
    const after = await resourceSample();
    const seconds = (performance.now() - started) / 1000;
    report.resources = { before, after, measuredSeconds: seconds, averageServingProcessCpuPercent: ((after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / (seconds * 1e6)) * 100, note: 'Single test-serving process including driver overhead; CPU wall interval includes Docker startup. RSS is before/after, not peak.' };
    assert.equal(code, 0, 'k6 threshold failure; see artifacts/k6-output.txt');
    report.load = JSON.parse(await readFile(resolve(artifacts, 'k6-baseline.json'), 'utf8'));
    console.log('K6_BASELINE_PASS');
  }
  if (canonical) {
    await dependencyCommand('mongo-offline');
    const unavailable=await fetch('http://127.0.0.1:5102/users/me',{headers:{authorization:`Bearer ${adminToken}`},signal:AbortSignal.timeout(10000)});
    assert.equal(unavailable.status,503,'Protected requests fail closed without Mongo authority');
    assert.equal((await fetch('http://127.0.0.1:5102/health')).status,200);
    assert.equal((await fetch('http://127.0.0.1:5102/ready')).status,503);
    report.security.checks.push('Mongo connection loss returns 503 while liveness stays available');
    report.security.limitations = report.proxy?.passed ? ['Primary election/failover is not covered by the connection-loss drill.'] : ['Live proxy verification requires --proxy.','Primary election/failover is not covered by the connection-loss drill.'];
    console.log('SECURITY_DEPENDENCY_PASS');
  }
  report.verificationPassed = true;
} catch (error) {
  report.verificationPassed = false;
  report.contractPassed ??= false;
  report.failure = error.message;
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  if (loadGateway?.listening) await new Promise(r => loadGateway.close(r));
  if (child?.connected) {
    child.send('shutdown');
    let shutdownTimer;
    const timeout = new Promise(resolveTimeout => { shutdownTimer=setTimeout(() => { report.shutdownTimedOut=true; child.kill(); resolveTimeout([1]); }, 15000); });
    const [code] = await Promise.race([childExited, timeout]);
    clearTimeout(shutdownTimer);
    if (code !== 0) { report.shutdownFailed = true; process.exitCode = 1; }
  }
  try {
    await client.close();
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(artifacts, `contract-report-${implementation}.json`), JSON.stringify(report, null, 2) + '\n');
    await writeFile(resolve(artifacts, `server-output-${implementation}.txt`), serverOutput);
  } finally { await releaseLock(); }
}
