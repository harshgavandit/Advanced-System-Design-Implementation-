export async function waitForGateway(base, {timeoutMs = 60000, intervalMs = 500} = {}) {
  const deadline = Date.now() + timeoutMs;
  let successes = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/ready', {signal: AbortSignal.timeout(Math.min(5000, Math.max(1, deadline - Date.now())))});
      const body = await response.json();
      successes = response.ok && body.status === 'ready' ? successes + 1 : 0;
      if (successes >= 2) return;
    } catch { successes = 0; }
    await new Promise(done => setTimeout(done, intervalMs));
  }
  throw new Error('Gateway readiness did not stabilize within the bounded startup deadline');
}
