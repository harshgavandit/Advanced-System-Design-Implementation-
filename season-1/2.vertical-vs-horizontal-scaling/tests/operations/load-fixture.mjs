import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {randomUUID,createHash} from 'node:crypto';import {writeFile} from 'node:fs/promises';
import {generateProducts,createManifest} from '/fixture/generate.mjs';
const require=createRequire('/app/package.json'),{mongo}=require('mongoose'),jwt=require('jsonwebtoken'),bcrypt=require('bcrypt');
assert.equal(process.env.MONGO_URI,'mongodb://mongo:27017/operations_test?replicaSet=operations');
const client=new mongo.MongoClient(process.env.MONGO_URI,{maxPoolSize:3});await client.connect();
try {
 const db=client.db('operations_test');assert.equal((await db.collection('_operations_owner').findOne({_id:'synthetic'}))?.owner,'scaling-operations-test');
 const products=generateProducts({count:10000,seed:42}),manifest=createManifest(products,42);
 await db.collection('products').deleteMany({});
 await db.collection('products').insertMany(products.map(row=>({...row,_id:new mongo.ObjectId(row._id),createdAt:new Date(row.createdAt),updatedAt:new Date(row.updatedAt)})),{writeConcern:{w:'majority'}});
 const password='Synthetic-load-fixture-password',passwordHash=await bcrypt.hash(password,10),pairs=[],auth=[];
 async function user(role,label) {
  const id=new mongo.ObjectId(),email='mixed-'+id+'@example.invalid',jti=randomUUID();
  await db.collection('users').insertOne({_id:id,name:'Synthetic '+label,email,passwordHash,role,isActive:true,createdAt:new Date(),updatedAt:new Date()});
  const options={algorithm:'HS256',issuer:'scaling-api',audience:'scaling-clients',keyid:'v1'};
  const accessToken=jwt.sign({sub:String(id),jti,type:'access'},process.env.LAB_ACCESS_SECRET,{...options,expiresIn:'15m'});
  const refreshToken=jwt.sign({sub:String(id),jti,type:'refresh',nonce:randomUUID()},process.env.LAB_REFRESH_SECRET,{...options,expiresIn:'7d'});
  await db.collection('sessions').insertOne({_id:jti,userId:id,refreshHash:createHash('sha256').update(refreshToken).digest('hex'),revoked:false,expiresAt:new Date(Date.now()+7*86400000)});
  return {id:String(id),email,password,accessToken,refreshToken};
 }
 // The 100 main VUs and two authentication VUs use instance-wide IDs.
 // Prepare all 102 possible slots even though only 100 execute the mixed flow.
 const pairCount=102;
 for(let i=0;i<pairCount;i++)pairs.push({user:await user('user','load user'),admin:await user('admin','authorized local ingestion operator')});
 for(let i=0;i<2;i++)auth.push(await user('user','authentication probe'));
 await writeFile('/results/sessions.json',JSON.stringify({pairs,auth,manifest,productIds:products.slice(0,pairCount).map(row=>row._id)}),{mode:0o600});
 console.log('SYNTHETIC_LOAD_FIXTURE_PASS 10000 products, 102 isolated session pairs, real JWT verification and Mongo session authority');
} finally {await client.close();}
