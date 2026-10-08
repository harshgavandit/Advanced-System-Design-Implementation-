import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateProducts, createManifest } from '../../../bench/fixtures/generate.mjs';
import { assertTestTarget } from '../target.mjs';
import { acquireRunLock, assertDatabaseOwner } from '../ownership.mjs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

test('same seed produces identical documents, IDs, timestamps and content hash', () => {
  const a = generateProducts({ count: 100, seed: 7 });
  const b = generateProducts({ count: 100, seed: 7 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 100);
  assert.equal(new Set(a.map(x => x._id)).size, 100);
  assert.equal(a[0].createdAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(createManifest(a, 7), createManifest(b, 7));
  assert.equal(createManifest(a, 7).sha256, createHash('sha256').update(a.map(x => JSON.stringify(x) + '\n').join('')).digest('hex'));
  assert.notEqual(createManifest(a, 7).sha256, createManifest(generateProducts({ count: 100, seed: 8 }), 8).sha256);
});

test('fixture includes skew, long text, zero stock, and manifest counts', () => {
  const products = generateProducts({ count: 100, seed: 42 });
  const manifest = createManifest(products, 42);
  assert.deepEqual(manifest.categories, { electronics: 60, books: 20, clothing: 15, home: 5 });
  assert.equal(products.filter(x => x.stock === 0).length, 10);
  assert.ok(products.some(x => x.description.length > 1000));
  assert.ok(products.every(x => /^[a-f0-9]{24}$/.test(x._id)));
  assert.equal(manifest.count, 100);
});

test('invalid sizes and seeds are refused before allocating data', () => {
  for (const count of [-1, 0, 1.5, Infinity, 1000001]) assert.throws(() => generateProducts({ count, seed: 42 }));
  for (const seed of [-1, 1.5, NaN, 4294967296]) assert.throws(() => generateProducts({ count: 1, seed }));
});

test('database writes accept only the exact isolated endpoint and database', () => {
  assert.equal(assertTestTarget('mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true'), 'phase0_contract_test');
  for (const uri of [
    'mongodb://127.0.0.1:27017/flip-commerce',
    'mongodb://127.0.0.1:28027/admin',
    'mongodb://example.com:28027/phase0_contract_test',
    'mongodb://user:pass@127.0.0.1:28027/phase0_contract_test',
    'mongodb://127.0.0.1:28027/phase0_contract_test?authSource=admin',
    'mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true&replicaSet=production',
    'mongodb://127.0.0.1:28027/phase0_contract_test_extra',
    'mongodb://localhost:28027/phase0_contract_test',
  ]) assert.throws(() => assertTestTarget(uri), /isolated/);
});

test('concurrent runs cannot acquire the same lock and an existing DB needs its owner marker', async () => {
  const testTmp = fileURLToPath(new URL('../artifacts/unit-tmp/', import.meta.url));
  await mkdir(testTmp, { recursive:true });
  const dir = await mkdtemp(join(testTmp, 'phase0-lock-'));
  try {
    const release = await acquireRunLock(join(dir, 'run.lock'));
    await assert.rejects(acquireRunLock(join(dir, 'run.lock')), /already active/);
    await release();
    await (await acquireRunLock(join(dir, 'run.lock')))();
    assertDatabaseOwner([], null);
    assert.throws(() => assertDatabaseOwner(['products'], null), /ownership/);
    assert.throws(() => assertDatabaseOwner(['products'], {_id:'another-tool'}), /ownership/);
    assertDatabaseOwner(['products'], {_id:'phase0-contract-tests', version:1});
  } finally { await rm(dir, {recursive:true}); }
});
