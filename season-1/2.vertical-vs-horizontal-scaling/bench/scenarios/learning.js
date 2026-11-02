import http from 'k6/http';
import {check} from 'k6';
import {Counter} from 'k6/metrics';
import exec from 'k6/execution';
const faultWindow=__ENV.FAULT_WINDOW==='true';
const correctnessFailures=new Counter('learning_correctness_failures');
export const options={
  scenarios:{learning:{executor:'constant-arrival-rate',rate:Number(__ENV.RATE),timeUnit:'1s',duration:__ENV.DURATION,preAllocatedVUs:20,maxVUs:80}},
  thresholds:{http_req_failed:['rate<0.01'],checks:[faultWindow?'rate>0.99':'rate==1'],learning_correctness_failures:['count==0'],dropped_iterations:['count==0']},
  summaryTrendStats:['avg','p(95)','p(99)','max'],
};
export default function(){
  // Scenario-global iteration IDs keep the 80/20 schedule independent of VUs.
  const iteration=exec.scenario.iterationInTest;
  if(iteration===0)console.log('LEARNING_TRAFFIC_STARTED');
  const privateRead=iteration%5===4;
  const path=privateRead?['/users/me','/cart','/wishlist'][iteration%3]:'/products?page=1&limit=20';
  const response=http.get('http://gateway:8080'+path,{headers:{'Accept-Encoding':'identity',...(privateRead?{Authorization:'Bearer '+__ENV.ACCESS_TOKEN}:{})},timeout:'5s',tags:{name:privateRead?'authenticated-user-read':'catalog-read'}});
  const transient=faultWindow&&[0,502,503,504].includes(response.status);
  const correct=(()=>{
    if(transient)return true;
    if(response.status!==200)return false;
    try{
      const body=response.json();
      if(privateRead)return path==='/users/me'?Boolean(body.email?.endsWith('@example.invalid')):Array.isArray(body.items);
      return body.items?.length===20&&body.totalItems>=10000&&body.items[0]?._id==='000000000000002a00000001'&&!response.headers['Content-Encoding'];
    }catch{return false;}
  })();
  correctnessFailures.add(correct?0:1);
  check(response,{'HTTP 200':r=>r.status===200,'correct successful response or explicit transient fault':()=>correct});
}
