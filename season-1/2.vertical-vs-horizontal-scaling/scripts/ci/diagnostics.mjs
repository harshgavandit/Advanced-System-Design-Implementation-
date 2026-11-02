import {spawnSync} from 'node:child_process';

// Read only the test project's Mongo logs before cleanup removes the container.
// Do not dump Compose config, inspect environment, application logs or secrets.
export function mongoDiagnostics(compose,{env=process.env,run=spawnSync,log=console.error}={}){
  for(const args of [['ps','-a'],['logs','--no-color','--tail','100','mongo']]){
    try{
      const result=run('docker',[...compose,...args],{env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
      let output=[result.stdout,result.stderr,result.error?.message].filter(Boolean).join('\n');
      for(const [key,value] of Object.entries(env))if(/secret|password|token/i.test(key)&&value?.length>=8)output=output.split(value).join('[REDACTED]');
      log(`Mongo failure diagnostics (${args[0]}):\n${output}`);
    }catch{/* Diagnostics must never hide the original gate failure. */}
  }
}
