import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export async function verifyProxy({ topic, artifacts, tokens }) {
  const image='nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236';
  const name=`scaling-security-proxy-${process.pid}`;
  // Exercise actual cache locations; only adapt optional compression and hosts
  // to Docker. No API/cache directives are replaced for this regression.
  const original=await readFile(resolve(topic,'servers/nginx/nginx.conf'),'utf8');
  const config=original.replace(/^load_module .*;\r?\n/gm,'').replace(/^\s*brotli[^;]*;\r?\n/gm,'')
    .replace('worker_processes auto;', 'worker_processes 1;')
    .replaceAll('127.0.0.1:5002','host.docker.internal:5102')
    .replace(/127\.0\.0\.1:(500[1345])/g,'host.docker.internal:$1');
  const file=resolve(artifacts,'security-nginx.conf');
  await writeFile(file,config);
  const docker=(args)=>{
    const result=spawnSync('docker',args,{encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,`Docker failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  docker(['run','-d','--rm','--name',name,'--cpus=0.25','--memory=128m','-p','127.0.0.1:18080:8080','-v',`${file}:/etc/nginx/nginx.conf:ro`,image]);
  try {
    for(let i=0;i<30;i++) {
      try { if((await fetch('http://127.0.0.1:18080/express/health')).status===200) break; } catch {}
      if(i===29) throw new Error('Proxy never became healthy');
      await new Promise(r=>setTimeout(r,200));
    }
    const identities=[];
    for(const token of [tokens[0],tokens[1],tokens[0],tokens[1]]) {
      const response=await fetch('http://127.0.0.1:18080/express/users/me',{headers:{authorization:`Bearer ${token}`}});
      assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'no-store');
      identities.push((await response.json())._id);
    }
    assert.notEqual(identities[0],identities[1]);
    assert.equal(identities[0],identities[2]);
    assert.equal(identities[1],identities[3]);
    assert.equal((await fetch('http://127.0.0.1:18080/express/users/me')).status,401);
    return {passed:true,image,checks:['alternating authenticated identities never share cached responses','anonymous request cannot receive authenticated response']};
  } finally { docker(['stop','--time','5',name]); }
}
