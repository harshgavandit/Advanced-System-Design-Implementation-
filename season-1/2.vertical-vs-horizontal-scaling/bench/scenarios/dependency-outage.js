import http from 'k6/http';
import {check} from 'k6';
import {Counter} from 'k6/metrics';
import exec from 'k6/execution';

const correctness=new Counter('learning_correctness_failures');
const unavailable=new Counter('learning_explicit_unavailable');
http.setResponseCallback(http.expectedStatuses(200,503));
export const options={
  scenarios:{outage:{executor:'constant-arrival-rate',rate:Number(__ENV.RATE),timeUnit:'1s',duration:__ENV.DURATION,preAllocatedVUs:40,maxVUs:160}},
  thresholds:{checks:['rate==1'],http_req_failed:['rate==0'],learning_correctness_failures:['count==0'],learning_explicit_unavailable:['count>0'],dropped_iterations:['count==0'],http_req_duration:['max<8000']},
  summaryTrendStats:['avg','p(95)','p(99)','max'],
};
export default function(){
  if(exec.scenario.iterationInTest===0)console.log('LEARNING_TRAFFIC_STARTED');
  const privateRead=exec.scenario.iterationInTest%5===4;
  const response=http.get('http://gateway:8080'+(privateRead?'/users/me':'/products?page=1&limit=20'),{headers:{'Accept-Encoding':'identity',...(privateRead?{Authorization:'Bearer '+__ENV.ACCESS_TOKEN}:{})},timeout:'9s',tags:{name:privateRead?'authority-read':'catalog-read'}});
  unavailable.add(response.status===503?1:0);
  const correct=(()=>{
    try{
      const body=response.json();
      if(response.status===503)return typeof body.error==='string'&&/^\d+$/.test(response.headers['Retry-After']??'')&&Number(response.headers['Retry-After'])>=1;
      if(response.status!==200)return false;
      return privateRead?body.email?.endsWith('@example.invalid'):body.items?.length===20&&body.totalItems>=10000&&body.items[0]?._id==='000000000000002a00000001';
    }catch{return false;}
  })();
  correctness.add(correct?0:1);
  check(response,{'correct successful body or explicit retryable unavailable':()=>Boolean(correct),'response bounded below 8s':r=>r.timings.duration<8000});
}
