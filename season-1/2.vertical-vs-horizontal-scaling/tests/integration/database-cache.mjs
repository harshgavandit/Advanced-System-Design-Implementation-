import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';

export async function verifyDatabaseCache({db,request,dependencyCommand}) {
  const results=[];
  const account=await request('signup',{body:{name:'Concurrency test',email:`phase5-${Date.now()}@example.invalid`,password:'Synthetic-phase5-password'},expected:201});
  const token=account.accessToken;
  const product=await db.collection('products').findOne({category:'books'});
  await request('addCart',{token,key:null,body:{productId:String(product._id),qty:1},expected:400});
  const keys=Array.from({length:16},()=>randomUUID());
  const lines=await Promise.all(keys.map(key=>request('addCart',{token,key,body:{productId:String(product._id),qty:1},expected:[200,201]})));
  assert.ok(lines.every(row=>row._id===lines[0]._id));
  let stored=await db.collection('cartitems').findOne({userId:new product._id.constructor(account.user.id),productId:product._id});
  assert.equal(stored.qty,16);
  const replays=await Promise.all(keys.map(key=>request('addCart',{token,key,body:{productId:String(product._id),qty:1},expected:[200,201]})));
  assert.ok(replays.every(row=>row._id===lines[0]._id));
  assert.equal((await db.collection('cartitems').findOne({_id:stored._id})).qty,16);
  await request('addCart',{token,key:keys[0],body:{productId:String(product._id),qty:2},expected:409});
  results.push('16 concurrent increments and 16 identical replays produce one line with qty=16');
  await request('updateCart',{token,id:lines[0]._id,body:{qty:1}});
  await dependencyCommand('arm-cart-delete-race');
  const raced=await request('adjustCart',{token,id:lines[0]._id,body:{delta:-1}});
  assert.equal(raced.qty,4,'A concurrent increment between guard miss and delete cannot be lost');
  assert.equal((await db.collection('cartitems').findOne({_id:stored._id})).qty,4);
  results.push('deterministic decrement/delete race preserves the intervening increment');
  const retryKey=randomUUID();
  const proxy=createServer((req,res)=>{
    const upstream=httpRequest('http://127.0.0.1:5102'+req.url,{method:req.method,headers:req.headers},reply=>{
      reply.resume(); reply.on('end',()=>res.destroy());
    });
    upstream.on('error',()=>res.destroy()); req.pipe(upstream);
  });
  await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
  try {
    await assert.rejects(fetch(`http://127.0.0.1:${proxy.address().port}/cart/${lines[0]._id}/quantity`,{method:'PATCH',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':retryKey},body:JSON.stringify({delta:2}),signal:AbortSignal.timeout(5000)}));
    const replay=await request('adjustCart',{token,key:retryKey,id:lines[0]._id,body:{delta:2}});
    assert.equal(replay.qty,6);
    assert.equal((await db.collection('cartitems').findOne({_id:stored._id})).qty,6);
  } finally {await new Promise(done=>proxy.close(done));}
  results.push('response loss after commit followed by retry applies the mutation once');
  const explain=await db.collection('products').find({category:'books'}).sort({_id:1}).limit(20).explain('executionStats');
  assert.equal(explain.executionStats.nReturned,20);
  assert.ok(explain.executionStats.totalDocsExamined<=20,'Category cursor query must avoid scanning all matching products');
  results.push({queryPlan:{returned:20,documentsExamined:explain.executionStats.totalDocsExamined,keysExamined:explain.executionStats.totalKeysExamined,index:'category_1__id_1'}});
  await dependencyCommand('redis-online');
  await dependencyCommand('cache-reset');
  await Promise.all(Array.from({length:16},()=>request('listProducts',{query:'?page=1&limit=20&category=books'})));
  const cacheStats=await dependencyCommand('cache-stats');
  assert.ok(cacheStats.loads<=2,'Cold identical misses must use single-flight');
  assert.ok(cacheStats.hits+cacheStats.joined>=14);
  const created=await request('createProduct',{body:{name:'Cache invalidation',description:'Synthetic test',price:3,stock:1,category:'books',imageUrl:'https://example.invalid/test'},expected:201});
  assert.equal((await request('getProduct',{id:created._id})).price,3);
  await request('updateProduct',{id:created._id,body:{price:4}});
  assert.equal((await request('getProduct',{id:created._id})).price,4);
  await request('deleteProduct',{id:created._id});
  await request('getProduct',{id:created._id,expected:404});
  await dependencyCommand('redis-offline');
  const offline=await request('listProducts',{query:'?page=1&limit=20&category=books'});
  assert.equal(offline.items.length,20);
  assert.equal((await request('getCart',{token,id:lines[0]._id})).qty,6);
  results.push('cold-cache single-flight, product invalidation and Redis-loss primary fallback preserve contents');
  await request('deleteCart',{token,id:lines[0]._id});
  return {passed:true,synthetic:true,results};
}
