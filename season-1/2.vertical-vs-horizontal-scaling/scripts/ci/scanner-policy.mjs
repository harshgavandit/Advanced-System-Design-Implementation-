import assert from 'node:assert/strict';

export function scannerArguments({name,scratch,snapshot,results,cache,image,args,input,platform=process.platform,uid,gid}){
  assert.match(name,/^scaling-ci-scan-[a-f0-9]{16}$/);
  assert.match(image,/^[a-z0-9/._-]+@sha256:[a-f0-9]{64}$/);
  const identity=[];
  if(platform==='linux'){
    assert.ok(Number.isInteger(uid)&&uid>=0&&Number.isInteger(gid)&&gid>=0,'Linux scans require the bind-mount owner identity');
    identity.push('--user',`${uid}:${gid}`);
  }
  return ['run','--rm','--name',name,'--label','scaling.owner=ci-security',...identity,
    '--cpus=1','--memory=1g','--cap-drop','ALL','--security-opt','no-new-privileges:true','--read-only',
    '-v',scratch+':/tmp','-v',snapshot+':/src:ro','-v',results+':/results','-v',cache+':/cache',
    '-e','HOME=/tmp','-e','SEMGREP_SEND_METRICS=off','-e','XDG_CACHE_HOME=/cache','-e','GRYPE_DB_CACHE_DIR=/cache',
    ...(input!==undefined?['-i']:[]),image,...args];
}
