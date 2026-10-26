import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {waitForServingPeers} from './gateway-peers.mjs';

async function withGateway(reply,work){
  const server=createServer(reply);await new Promise(done=>server.listen(0,'127.0.0.1',done));
  try{await work(`http://127.0.0.1:${server.address().port}`);}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
}
test('discovery waits through more than forty one-peer responses and verifies every expected replica',async()=>{
  let calls=0;const peers=['10.0.0.1:5002','10.0.0.2:5002','10.0.0.3:5002','10.0.0.4:5002'];
  await withGateway((_req,res)=>{calls++;res.writeHead(200,{'content-type':'application/json','x-lab-upstream':peers[calls<=45?0:calls%4]});res.end('{"status":"ready"}');},async base=>{
    const result=await waitForServingPeers(base,peers,{timeoutMs:3000,intervalMs:1});
    assert.ok(result.attempts>40);assert.deepEqual(result.observed,peers);
  });
});
test('missing, foreign, unhealthy and ready-looking wrong-body peers cannot fill expected membership',async()=>{
  let calls=0;const peers=['10.0.0.1:5002','10.0.0.2:5002'];
  await withGateway((_req,res)=>{
    const i=calls++%4;res.writeHead(i===2?503:200,{'content-type':'application/json',...(i===0?{}:{'x-lab-upstream':i===1?'10.0.0.99:5002':peers[1]})});
    res.end(JSON.stringify({status:i===3?'not_ready':'ready'}));
  },async base=>{await assert.rejects(waitForServingPeers(base,peers,{timeoutMs:120,intervalMs:1}),/0\/2/);});
  await assert.rejects(waitForServingPeers('http://127.0.0.1:1',[],{}),/nonempty/);
});
