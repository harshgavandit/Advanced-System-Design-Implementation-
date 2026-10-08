import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { yaml, SwaggerParser } from '../dependencies.mjs';
import { assertSchema, selectOperations } from '../schema.mjs';

test('OpenAPI validates and every capability refers to an actual unique operation', async () => {
  const spec = yaml.load(await readFile(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8'));
  await SwaggerParser.validate(structuredClone(spec));
  const matrix = JSON.parse(await readFile(new URL('../../../contracts/capabilities.json', import.meta.url), 'utf8'));
  const operations = Object.values(spec.paths).flatMap(p => Object.values(p).filter(x => x.operationId).map(x => x.operationId));
  assert.equal(new Set(operations).size, operations.length);
  assert.ok(operations.length >= 26);
  for (const entry of Object.values(matrix.implementations)) {
    const declared = [...entry.supported, ...entry.unsupported];
    assert.equal(new Set(declared).size, operations.length);
    assert.deepEqual([...declared].sort(), [...operations].sort());
  }
  const go = selectOperations(spec, matrix, 'go');
  assert.deepEqual(go.supported.sort(), ['getHealth', 'getMetrics', 'listProducts']);
  assert.ok(go.unsupported.includes('signup'));
  assert.throws(() => selectOperations(spec, matrix, 'unknown'), /Unknown/);
});

test('response validator rejects wrong types, missing fields, ranges, and union mismatches', () => {
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['_id', 'qty'], properties: { _id: { type: 'string', pattern: '^[a-f0-9]{24}$' }, qty: { type: 'integer', minimum: 1 } } } } } };
  assertSchema(schema, { items: [{ _id: '000000000000000000000001', qty: 2 }] });
  for (const invalid of [{}, {items:{}}, {items:[{}]}, {items:[{_id:'bad',qty:2}]}, {items:[{_id:'000000000000000000000001',qty:0}]}]) {
    assert.throws(() => assertSchema(schema, invalid));
  }
  const union = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  assertSchema(union, null);
  assertSchema(union, 'cursor');
  assert.throws(() => assertSchema(union, 3));
  assert.throws(() => assertSchema({ type:'object', additionalProperties:false }, { leaked:'secret' }));
});

test('request contract rejects whitespace-only product fields, invalid gender and unknown-only patches', async () => {
  const spec = await SwaggerParser.validate(yaml.load(await readFile(new URL('../../../contracts/openapi.yaml', import.meta.url), 'utf8')));
  const schemas = spec.components.schemas;
  const product = {name:' ',description:'valid',price:1,stock:1,category:'test',imageUrl:'x'};
  assert.throws(() => assertSchema(schemas.ProductInput, product));
  assert.throws(() => assertSchema(schemas.Signup, {name:'user',email:'u@example.invalid',password:'12345678',gender:'invalid'}));
  assert.throws(() => assertSchema(schemas.ProfilePatch, {gender:'invalid'}));
  assert.throws(() => assertSchema(schemas.ProfilePatch, {unknown:1}));
  assert.throws(() => assertSchema(schemas.ProductPatch, {unknown:1}));
  assertSchema(schemas.ProductPatch, {price:0, ignoredExtra:'allowed by application'});
});
