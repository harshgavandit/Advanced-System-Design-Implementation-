import { open, unlink } from 'node:fs/promises';

export async function acquireRunLock(path) {
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Phase 0 run already active (or stale run.lock requires inspection)'); throw error; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => { await handle.close(); await unlink(path); };
}

export function assertDatabaseOwner(collections, marker) {
  if (collections.length && (marker?._id !== 'phase0-contract-tests' || marker.version !== 1)) {
    throw new Error('Database ownership marker missing; refusing reset');
  }
}
