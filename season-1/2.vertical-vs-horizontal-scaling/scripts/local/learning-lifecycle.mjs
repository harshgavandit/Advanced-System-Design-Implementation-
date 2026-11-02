import assert from 'node:assert/strict';
import {mkdir,rmdir,readFile,unlink,open} from 'node:fs/promises';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

export async function acquireRunnerLock(path){
  const guard=path+'.acquiring';
  try{await mkdir(guard);}catch(error){if(error.code==='EEXIST')throw new Error('Runner lock acquisition is active or interrupted; inspect its guard before recovery');throw error;}
  const lease=randomUUID();
  try{
    try{
      const existing=JSON.parse(await readFile(path,'utf8'));
      assert.equal(existing.host,hostname(),'Lock belongs to another machine');
      assert.equal(existing.owner,'learning-lab','Unrecognized lock owner');
      assert.ok(Number.isSafeInteger(existing.pid)&&existing.pid>0,'Invalid lock PID');
      let alive=true;try{process.kill(existing.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
      assert.ok(!alive,`Another learning runner is active (PID ${existing.pid})`);
      await unlink(path);
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const file=await open(path,'wx');
    try{await file.writeFile(JSON.stringify({owner:'learning-lab',host:hostname(),pid:process.pid,lease}));}finally{await file.close();}
  }finally{await rmdir(guard);}
  return {lease,async release(){if(JSON.parse(await readFile(path,'utf8')).lease===lease)await unlink(path);}};
}

export function runCommand(binary,args,{input,timeout=180000,allowFailure=false,stream=false,cwd,env,signal,onOutput}={}){
  return new Promise((done,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const child=spawn(binary,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
    const fail=error=>{if(settled)return;settled=true;cleanup();child.kill();reject(error);};
    const cancel=()=>fail(signal.reason);
    const timer=setTimeout(()=>fail(new Error(`${binary} timed out after ${timeout}ms`)),timeout);
    signal?.addEventListener('abort',cancel,{once:true});
    child.stdout.on('data',chunk=>{stdout+=chunk;onOutput?.(chunk.toString());if(stream)process.stdout.write(chunk);});
    child.stderr.on('data',chunk=>{stderr+=chunk;onOutput?.(chunk.toString());if(stream)process.stderr.write(chunk);});
    child.on('error',fail);
    child.on('close',code=>{
      if(settled)return;settled=true;cleanup();
      const result={code,stdout:stdout.trim(),stderr:stderr.trim()};
      if(code!==0&&!allowFailure)reject(new Error(`${binary} failed (${code}): ${stderr.slice(-2000)}`));else done(result);
    });
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export function trafficStart(){
  let started=false,buffer='',resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,observe(chunk){if(started)return;buffer=(buffer+chunk).slice(-4096);if(buffer.includes('LEARNING_TRAFFIC_STARTED')){started=true;resolve(Date.now());}}};
}
