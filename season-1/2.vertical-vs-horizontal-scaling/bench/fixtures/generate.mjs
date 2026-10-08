import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function generateProducts({ count = 10000, seed = 42 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 1000000) throw new Error('count must be an integer from 1 to 1000000');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be an unsigned 32-bit integer');
  let state = seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  return Array.from({ length: count }, (_, i) => {
    const bucket = i % 100;
    const category = bucket < 60 ? 'electronics' : bucket < 80 ? 'books' : bucket < 95 ? 'clothing' : 'home';
    return {
      _id: (BigInt(seed) * 0x100000000n + BigInt(i + 1)).toString(16).padStart(24, '0'),
      name: `${category} fixture ${i + 1}`,
      description: i % 100 === 0 ? 'Long synthetic catalog description. '.repeat(64) : `Deterministic synthetic product ${i + 1}`,
      price: (random() % 100000) / 100,
      stock: i % 10 === 0 ? 0 : random() % 1000 + 1,
      category,
      imageUrl: `https://fixtures.example.invalid/products/${i + 1}.png`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  });
}

export const serializeProducts = products => products.map(p => JSON.stringify(p) + '\n').join('');

export function createManifest(products, seed) {
  const categories = {};
  for (const p of products) categories[p.category] = (categories[p.category] ?? 0) + 1;
  return { schemaVersion: 1, generator: 'lcg-v1', seed, count: products.length, categories,
    sha256: createHash('sha256').update(serializeProducts(products)).digest('hex'),
    encoding: 'UTF-8 NDJSON with LF, including final LF', synthetic: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = Number(process.argv[2] ?? 10000);
  const seed = Number(process.argv[3] ?? 42);
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../tests/phase0/artifacts/fixtures');
  const products = generateProducts({ count, seed });
  const manifest = createManifest(products, seed);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'products.ndjson'), serializeProducts(products));
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ output, manifest }, null, 2));
}
