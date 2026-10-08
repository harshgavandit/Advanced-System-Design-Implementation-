import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer,get} from 'node:http';
import {once} from 'node:events';
import zlib from 'node:zlib';
import {randomBytes} from 'node:crypto';
const require=createRequire(new URL('../../servers/02-express/package.json',import.meta.url));

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
