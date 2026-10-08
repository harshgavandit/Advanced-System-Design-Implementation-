import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
export async function journey({base,users,admin}){
 async function request(path,{method='GET',token,body,key=randomUUID(),statuses=[200]}={}){
  const response=await fetch(base+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{}),...(['GET','HEAD'].includes(method)?{}:{'idempotency-key':key})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
  assert.ok(statuses.includes(response.status),method+' '+path+' status '+response.status);return response.json();
 }
 const tokens=[];
 for(const user of users){const login=await request('/users/login',{method:'POST',body:user});tokens.push(login.accessToken);}
 const catalog=await request('/products?page=1&limit=20');assert.ok(catalog.items.length>0);const productId=catalog.items[0]._id;
 for(let i=0;i<tokens.length;i++)assert.equal((await request('/users/me',{token:tokens[i]})).email,users[i].email);
 const key=randomUUID(),line=await request('/cart',{method:'POST',token:tokens[0],body:{productId,qty:1},key,statuses:[200,201]});
 assert.deepEqual(await request('/cart',{method:'POST',token:tokens[0],body:{productId,qty:1},key,statuses:[200,201]}),line);
 await request('/cart/'+line._id,{token:tokens[1],statuses:[404]});
 assert.equal((await request('/cart/'+line._id,{token:tokens[0]})).qty,line.qty);
 await request('/cart/'+line._id,{method:'DELETE',token:tokens[0]});
 const wishlist=await request('/wishlist',{method:'POST',token:tokens[0],body:{productId},statuses:[201]});
 await request('/wishlist/'+wishlist._id,{token:tokens[1],statuses:[404]});
 await request('/wishlist/'+wishlist._id,{method:'DELETE',token:tokens[0]});
 if(admin){
  const operator=await request('/users/login',{method:'POST',body:admin}),marker='Synthetic release '+randomUUID();
  const job=await request('/products/ingest',{method:'POST',token:operator.accessToken,statuses:[202],body:{name:marker,description:'synthetic release validation',price:1,stock:1,category:'books',imageUrl:'https://example.invalid/synthetic'}});
  let status;const deadline=Date.now()+30000;
  while(Date.now()<deadline){status=await request('/ingestion-jobs/'+job.jobId,{token:operator.accessToken});if(status.status==='succeeded')break;assert.notEqual(status.status,'failed');await new Promise(done=>setTimeout(done,250));}
  assert.equal(status.status,'succeeded');assert.equal((await request('/products/'+status.productId)).name,marker);
  await request('/products/'+status.productId,{method:'DELETE',token:operator.accessToken});
 }
 for(const token of tokens){await request('/users/logout',{method:'POST',token});await request('/users/me',{token,statuses:[401]});}
 return {passed:true,checks:['catalog contents','two-user identity','cart idempotent replay and immediate read','cart/wishlist ownership','logout revocation',...(admin?['durable ingestion completion']:[])]};
}
