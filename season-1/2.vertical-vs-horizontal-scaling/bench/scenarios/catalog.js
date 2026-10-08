import http from 'k6/http';
import { check } from 'k6';

const rate=Number(__ENV.RATE || 100);
export const options={
  scenarios:{catalog:{executor:'constant-arrival-rate',rate,timeUnit:'1s',duration:__ENV.DURATION||'10m',preAllocatedVUs:50,maxVUs:200}},
  thresholds:{http_req_failed:['rate==0'],checks:['rate==1'],dropped_iterations:['count==0'],http_req_duration:['p(95)<150','p(99)<300']},
  summaryTrendStats:['avg','p(95)','p(99)','max'],
};
export default function() {
  const response=http.get(__ENV.URL||'http://gateway:8080/products?page=1&limit=20',{headers:{'Accept-Encoding':'identity'},tags:{operation:'catalog-offset'}});
  let body; try {body=response.json();}catch{}
  check(response,{
    'success':r=>r.status===200,
    'identity transfer':r=>!r.headers['Content-Encoding'],
    'correct populated page':()=>body?.items?.length===20 && body?.totalItems===10000,
    'deterministic first record':()=>body?.items?.[0]?._id==='000000000000002a00000001',
  });
}
