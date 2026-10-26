import assert from 'node:assert/strict';

// Docker DNS can initially resolve only the first healthy replica. Observe
// routing to the exact inspected endpoints across bounded discovery refreshes.
export async function waitForServingPeers(base, expected, {timeoutMs=60000,intervalMs=200}={}) {
  assert.ok(expected.length>0&&new Set(expected).size===expected.length,'Expected peers must be nonempty and unique');
  const allowed=new Set(expected),observed=new Set();
  const deadline=Date.now()+timeoutMs;let attempts=0,lastError;
  while(Date.now()<deadline){
    attempts++;
    try{
      const response=await fetch(base+'/ready',{headers:{connection:'close'},signal:AbortSignal.timeout(Math.min(5000,Math.max(1,deadline-Date.now())))});
      const body=await response.json(),peer=response.headers.get('x-lab-upstream');
      if(response.status===200&&body.status==='ready'&&allowed.has(peer))observed.add(peer);
      else lastError=`status=${response.status}, peer=${peer??'missing'}`;
      if(observed.size===allowed.size)return {expected:[...allowed].sort(),observed:[...observed].sort(),attempts};
    }catch(error){lastError=error.message;}
    await new Promise(done=>setTimeout(done,intervalMs));
  }
  throw new Error(`Not all expected replicas served traffic within the startup deadline: ${observed.size}/${allowed.size}; ${lastError??'waiting for discovery'}`);
}
