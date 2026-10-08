import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),folder=resolve(topic,'infra/compose/artifacts');
function docker(args){const result=spawnSync('docker',args,{encoding:'utf8',timeout:60000});assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
const ids=docker(['ps','--filter','label=com.docker.compose.project=scaling-production-lab','--filter','label=com.docker.compose.service=api','--format','{{.ID}}']).split(/\r?\n/).filter(Boolean);
assert.equal(ids.length,4);
const configs=JSON.parse(docker(['inspect',...ids]));for(const config of configs)assert.equal(config.Config.Labels['scaling.owner'],'production-lab');
const report={startedAt:new Date().toISOString(),passed:false,synthetic:true,cloud:false,image:configs[0].Image,cycles:[]};
const victim=ids[3],name='scaling-gateway-failover-'+process.pid;let stopped=false,output='',loadDone;
try{
  const child=spawn('docker',['run','--rm','--name',name,'--label','scaling.owner=production-lab','--network','scaling-production-lab_backend','--cpus=1','--memory=512m','-v',resolve(topic,'bench/scenarios')+':/scripts:ro','-v',folder+':/results','-e','RATE=100','-e','DURATION=3m','grafana/k6@sha256:e66db15b860113878fa74670e31f5e274830b7b6e42c8bff28b2f2d86a257603','run','--summary-export=/results/gateway-failover-k6.json','/scripts/catalog.js'],{stdio:['ignore','pipe','pipe']});
  loadDone=once(child,'exit');child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  await delay(10000);
  for(let cycle=1;cycle<=3;cycle++){
    docker(['stop','--timeout','20',victim]);stopped=true;
    await delay(12000);
    const survivorDNS=JSON.parse(docker(['exec',ids[1],'node','-e',"require('node:dns').resolve4('api',(error,addresses)=>{if(error)process.exit(1);console.log(JSON.stringify(addresses))})"]));
    assert.equal(survivorDNS.length,3,'Only the three surviving endpoints should resolve');
    docker(['start',victim]);stopped=false;
    const deadline=Date.now()+30000;let healthy=false;
    while(Date.now()<deadline){if(JSON.parse(docker(['inspect',victim]))[0].State.Health.Status==='healthy'){healthy=true;break;}await delay(500);}
    assert.ok(healthy,'Restarted test replica must recover');
    report.cycles.push({cycle,survivorDNS,restoredHealthy:healthy});console.log('GATEWAY_FAILOVER_PROGRESS cycle='+cycle);
    await delay(12000);
  }
  const [code]=await loadDone;report.load=JSON.parse(await readFile(resolve(folder,'gateway-failover-k6.json'),'utf8'));
  assert.equal(code,0,'Repeated stop/restart traffic must retain all content and zero failures');
  report.passed=true;console.log('GATEWAY_FAILOVER_PASS three stop/restart cycles at 100 catalog requests/s');
}catch(error){report.failure=error.message;throw error;}
finally{
  if(stopped)docker(['start',victim]);if(loadDone)await loadDone;
  report.finishedAt=new Date().toISOString();await writeFile(resolve(folder,'gateway-failover-output.txt'),output);await writeFile(resolve(folder,'gateway-failover.json'),JSON.stringify(report,null,2)+'\n');
}
