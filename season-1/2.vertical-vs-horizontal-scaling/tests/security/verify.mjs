import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function verifySecurity({ db, request, adminToken, productId, serverRequire, dependencyCommand }) {
  const checks = [];
  const base = 'http://127.0.0.1:5102';
  const raw = async (path, options = {}) => fetch(base + path, { ...options, signal:AbortSignal.timeout(10000) });
  const login = () => request('login',{body:{email:'phase0-b@example.invalid',password:'Synthetic-test-password-42'}});
  const pair = await login();
  const rotated = await request('refresh',{body:{refreshToken:pair.refreshToken}});
  assert.notEqual(rotated.refreshToken, pair.refreshToken);
  await request('refresh',{body:{refreshToken:pair.refreshToken},expected:401});
  await request('getProfile',{token:rotated.accessToken,expected:401});
  checks.push('refresh reuse revokes the whole family');

  const raced = await login();
  const contenders = await Promise.all([0,1].map(() => raw('/users/refresh',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refreshToken:raced.refreshToken}),
  })));
  assert.deepEqual(contenders.map(r=>r.status).sort(),[200,401]);
  const winner = await contenders.find(r=>r.status===200).json();
  await request('getProfile',{token:winner.accessToken,expected:401});
  checks.push('concurrent refresh has one winner and requires reauthentication');

  const fresh = await login();
  const claims = JSON.parse(Buffer.from(fresh.accessToken.split('.')[1],'base64url'));
  const family = await db.collection('sessions').findOne({_id:claims.jti});
  assert.equal(family.refreshHash,createHash('sha256').update(fresh.refreshToken).digest('hex'));
  assert.ok(!JSON.stringify(family).includes(fresh.refreshToken));
  const redis = serverRequire('redis').createClient({url:'redis://127.0.0.1:28028',socket:{reconnectStrategy:false}});
  redis.on('error',()=>{});
  await redis.connect();
  try {
    await dependencyCommand('redis-online');
    await redis.set(`session:${claims.jti}`,claims.sub,{EX:60});
    await request('logout',{token:fresh.accessToken});
    await request('getProfile',{token:fresh.accessToken,expected:401});
    await dependencyCommand('redis-offline');
    await request('getProfile',{token:fresh.accessToken,expected:401});
    await dependencyCommand('redis-online');
    await request('getProfile',{token:fresh.accessToken,expected:401});
  } finally { await redis.del(`session:${claims.jti}`); await redis.quit(); }
  checks.push('stale positive Redis cache cannot resurrect a revoked session');

  const disabled = await login();
  await request('updateProfile',{token:disabled.accessToken,body:{isActive:false}});
  await request('refresh',{body:{refreshToken:disabled.refreshToken},expected:401});
  await request('getProfile',{token:disabled.accessToken,expected:401});
  checks.push('disabled account cannot access or refresh');

  for (const [method,path] of [['POST','/products'],['PUT',`/products/${productId}`],['DELETE',`/products/${productId}`],['POST','/products/ingest'],['GET','/products/ingest/stats']]) {
    assert.equal((await raw(path,{method})).status,401);
  }
  checks.push('every administrative route rejects unauthenticated access');
  assert.equal((await raw('/products?page=1000000')).status,400);
  assert.equal((await raw('/products?category='+'a'.repeat(101))).status,400);
  assert.equal((await raw('/products',{headers:{origin:'https://untrusted.example.invalid'}})).status,403);
  const correlated=await raw('/health',{headers:{'x-request-id':'test_request_42'}});
  assert.equal(correlated.headers.get('x-request-id'),'test_request_42');
  assert.equal(correlated.headers.get('cache-control'),'no-store');
  assert.equal((await raw('/users/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"password":"do-not-echo"'})).status,400);
  const oversized=await raw('/products',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'x'.repeat(40000)})});
  assert.equal(oversized.status,413);
  assert.ok(!(await oversized.text()).includes('xxxx'));
  checks.push('CORS, body size, pagination, query and correlation controls');

  // Place only this synthetic principal at its quota boundary, no real data.
  const adminClaims=JSON.parse(Buffer.from(adminToken.split('.')[1],'base64url'));
  const window=Math.floor(Date.now()/60000);
  const key=createHash('sha256').update(`write:${adminClaims.sub}:${window}`).digest('hex');
  await db.collection('requestquotas').updateOne({_id:key},{$set:{count:120,expiresAt:new Date(Date.now()+120000)}},{upsert:true});
  assert.equal((await raw('/products',{method:'POST',headers:{authorization:`Bearer ${adminToken}`,'content-type':'application/json'},body:'{}'})).status,429);
  checks.push('shared per-principal write quota is enforced');
  assert.ok(await db.collection('securityaudits').countDocuments({outcome:'denied'})>0);
  assert.ok(await db.collection('securityaudits').countDocuments({action:'refresh-family-revoked'})>0);
  const nginx=await readFile(new URL('../../servers/nginx/nginx.conf',import.meta.url),'utf8');
  assert.ok(!/proxy_cache\s+(?!off\b)\w+;/.test(nginx));
  checks.push('audit events persisted and all proxy cache locations disabled');
  return { passed:true, checks, limitations:['Proxy configuration checked statically; a live Nginx two-user test remains required.','Mongo outage and primary failover need isolated fault injection.'] };
}
