import assert from 'node:assert/strict';

// Validates the response-schema subset used in this baseline; SwaggerParser
// separately validates the complete OpenAPI document and resolves references.
export function assertSchema(schema, value, path = '$') {
  if (value === null && schema.nullable) return;
  if (schema.anyOf || schema.oneOf) {
    const matches = (schema.anyOf ?? schema.oneOf).filter(s => {
      try { assertSchema(s, value, path); return true; } catch { return false; }
    });
    assert.ok(schema.oneOf ? matches.length === 1 : matches.length > 0, `${path}: union mismatch`);
  }
  if (schema.not) assert.throws(() => assertSchema(schema.not, value, path), `${path}: forbidden value`);
  if (schema.enum) assert.ok(schema.enum.some(x => Object.is(x, value)), `${path}: enum mismatch`);
  const type = schema.type;
  if (!type && schema.required) {
    for (const key of schema.required) assert.ok(value && Object.hasOwn(value, key), `${path}.${key}: required`);
  }
  if (type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path}: expected object`);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key}: required`);
    if (schema.minProperties !== undefined) assert.ok(Object.keys(value).length >= schema.minProperties, `${path}: too few properties`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) assertSchema(schema.properties[key], child, `${path}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${path}.${key}: unexpected property`);
    }
  } else if (type === 'array') {
    assert.ok(Array.isArray(value), `${path}: expected array`);
    for (let i = 0; i < value.length; i++) assertSchema(schema.items, value[i], `${path}[${i}]`);
  } else if (type === 'integer' || type === 'number') {
    assert.ok(typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value)), `${path}: expected ${type}`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path}: below minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path}: above maximum`);
  } else if (type === 'null') assert.equal(value, null, `${path}: expected null`);
  else if (type) {
    assert.equal(typeof value, type, `${path}: expected ${type}`);
    if (type === 'string') {
      if (schema.pattern) assert.match(value, new RegExp(schema.pattern), path);
      if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${path}: too short`);
      if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, `${path}: too long`);
    }
  }
}

export function selectOperations(spec, matrix, implementation) {
  const entry = matrix.implementations[implementation];
  if (!entry) throw new Error(`Unknown implementation: ${implementation}`);
  const available = Object.values(spec.paths).flatMap(path => Object.values(path).map(op => op.operationId).filter(Boolean));
  assert.deepEqual([...entry.supported, ...entry.unsupported].sort(), available.sort(), 'Capability matrix must account for every operation exactly once');
  return structuredClone(entry);
}
