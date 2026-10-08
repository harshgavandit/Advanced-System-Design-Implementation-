import {spawnSync} from 'node:child_process';
import {appendFile} from 'node:fs/promises';
import {topicChanged,requiredCheck} from './policy.mjs';
if(process.argv.includes('--required')){
  const changed=process.env.TOPIC_CHANGED;
  if(!['true','false'].includes(changed))throw new Error('Changed-path job must complete before the required gate');
  const passed=requiredCheck(changed==='true',JSON.parse(process.env.CHECK_RESULTS??'{}'));
  if(!passed)throw new Error('A relevant required scaling check failed, was cancelled or did not run');
  console.log('SCALING_REQUIRED_PASS'+(changed==='false'?' unrelated paths, checks intentionally skipped':''));
}else{
  const base=process.env.BASE_SHA,head=process.env.HEAD_SHA;
  let changed=true;
  if(base&&head&&base!=='0'.repeat(40)){
    for(const ref of [base,head])if(!/^[a-f0-9]{40}$/i.test(ref))throw new Error('Expected full immutable Git SHA');
    const result=spawnSync('git',['diff','--name-only','-z',base,head,'--'],{encoding:'utf8'});
    if(result.status!==0)throw new Error('Cannot determine changed paths; refusing to silently skip checks');
    changed=topicChanged(result.stdout.split('\0').filter(Boolean));
  }
  if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`topic=${changed}\n`);
  console.log('TOPIC_CHANGED='+changed);
}
