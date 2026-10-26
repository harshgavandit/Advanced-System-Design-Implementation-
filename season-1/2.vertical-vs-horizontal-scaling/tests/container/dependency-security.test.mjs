import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer,get} from 'node:http';
import {once} from 'node:events';
import zlib from 'node:zlib';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../servers/02-express/package.json',import.meta.url));

test('malformed compressed JSON cannot crash the resolved Express parser process',()=>{
  const probe=`
    const assert=require('node:assert/strict'),{createRequire}=require('node:module'),{gzipSync}=require('node:zlib');
    const express=createRequire(process.argv[1])('express'),app=express();
    app.use(express.json({limit:'32kb',strict:true}));
    app.post('/body',(req,res)=>res.json({accepted:true}));
    app.get('/health',(_req,res)=>res.json({status:'ok'}));
    app.use((error,_req,res,_next)=>res.status(error.status||400).json({error:'Invalid body'}));
    const server=app.listen(0,'127.0.0.1',async()=>{
      try{
        const base='http://127.0.0.1:'+server.address().port;
        const valid=await fetch(base+'/body',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:gzipSync('{"valid":true}')});
        assert.equal(valid.status,200);await valid.arrayBuffer();
        // A finished gzip member followed by a large tail exercises the late
        // decoder-error path; a tiny malformed frame only tests normal 400s.
        const malformed=Buffer.concat([gzipSync('{"valid":true}'),Buffer.from([0]),Buffer.alloc(100*1024,0x58)]);
        const response=await fetch(base+'/body',{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:malformed});
        assert.ok([200,400].includes(response.status));await response.arrayBuffer();
        await new Promise(done=>setTimeout(done,100));
        assert.equal((await fetch(base+'/health')).status,200);
        server.closeAllConnections();server.close();
      }catch(error){console.error(error.message);server.closeAllConnections();server.close();process.exitCode=1;}
    });`;
  const result=spawnSync(process.execPath,['-e',probe,fileURLToPath(new URL('../../servers/02-express/package.json',import.meta.url))],{encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined,'Parser regression probe must finish');
  assert.equal(result.status,0,result.stderr||'Compressed input crashed the API process');
});

test('the resolved Express proxy dependency does not trust arbitrary IPv4 peers via a short mapped IPv6 prefix',()=>{
  const expressRequire=createRequire(require.resolve('express'));
  const proxy=expressRequire('proxy-addr');
  const trust=proxy.compile('::ffff:10.0.0.0/8');
  assert.equal(trust('203.0.113.10',0),false);
  assert.equal(proxy({socket:{remoteAddress:'203.0.113.10'},headers:{'x-forwarded-for':'198.51.100.22'}},trust),'203.0.113.10');
  assert.equal(proxy.compile('10.0.0.0/8')('10.1.2.3',0),true);
});

test('client disconnect destroys the real gzip stream and releases its native handle',{timeout:5000},async t=>{
  const compression=require('compression');
  const descriptor=Object.getOwnPropertyDescriptor(zlib,'createGzip');
  let stream;
  Object.defineProperty(zlib,'createGzip',{...descriptor,value(...args){stream=descriptor.value(...args);return stream;}});
  const middleware=compression({threshold:0});
  const server=createServer((req,res)=>middleware(req,res,()=>{
    res.setHeader('Content-Type','text/plain');
    res.write(randomBytes(65536));
    res.flush();
  }));
  t.after(()=>{Object.defineProperty(zlib,'createGzip',descriptor);stream?.destroy();server.closeAllConnections();server.close();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const closed=new Promise(resolve=>server.once('request',(_req,res)=>res.once('close',resolve)));
  await new Promise((resolve,reject)=>{
    const request=get({host:'127.0.0.1',port:server.address().port,headers:{'Accept-Encoding':'gzip'}},res=>res.once('data',()=>{res.destroy();resolve();}));
    request.on('error',reject);
  });
  await closed;
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(stream,'The test must create a real gzip stream');
  assert.equal(stream.destroyed,true,'Disconnected response must not retain a live compression stream');
  assert.equal(stream._handle,null,'The native zlib handle must be released');
});
