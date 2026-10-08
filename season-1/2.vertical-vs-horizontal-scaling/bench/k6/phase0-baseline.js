import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: { baseline: { executor: 'constant-arrival-rate', rate: Number(__ENV.RATE || 20), timeUnit: '1s', duration: __ENV.DURATION || '2m', preAllocatedVUs: 20, maxVUs: 100, gracefulStop: '10s' } },
  thresholds: { http_req_failed: ['rate==0'], checks: ['rate==1'], dropped_iterations: ['count==0'] },
  summaryTrendStats: ['avg', 'p(95)', 'p(99)'],
};

export default function () {
  const response = http.get(__ENV.URL, { headers: { 'Accept-Encoding': 'identity', 'X-Phase0-Key': __ENV.PHASE0_GATE_TOKEN }, timeout: '8s' });
  let body;
  try { body = response.json(); } catch { body = null; }
  check(response, {
    'status 200': r => r.status === 200,
    '20 populated products and 10000 total': () => body?.items?.length === 20 && body.totalItems === 10000,
    'deterministic first product': () => body?.items?.[0]?._id === '000000000000002a00000001',
  });
}
