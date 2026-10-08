import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scannerArguments} from './scanner-policy.mjs';

// Real scanner regression, including Linux owner-only directories and redaction.
// Generated credentials are synthetic and stay in ignored D-drive/runner artifacts.
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const root=resolve(topic,'infra/compose/artifacts/ci');await mkdir(root,{recursive:true});
const folder=await mkdtemp(resolve(root,'scanner-regression-'));
const source=resolve(folder,'source'),results=resolve(folder,'results'),scratch=resolve(folder,'temp'),cache=resolve(folder,'cache');
for(const path of [source,results,scratch,cache])await mkdir(path,{mode:0o700});
if(process.platform==='linux'){
  const permissions=await stat(source);assert.equal(permissions.mode&0o777,0o700);assert.equal(permissions.uid,process.getuid());
}
await writeFile(resolve(source,'config.toml'),await readFile(resolve(topic,'scripts/ci/gitleaks.toml')));
await writeFile(resolve(source,'clean.txt'),'No credentials in this synthetic fixture.\n');
function scan(report){
  const name='scaling-ci-scan-'+randomBytes(8).toString('hex');
  const args=scannerArguments({name,snapshot:source,results,scratch,cache,uid:process.getuid?.(),gid:process.getgid?.(),
    image:'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f',
    args:['dir','/src','--config','/src/config.toml','--redact','--report-format','json','--report-path','/results/'+report]});
  // This regression does not need network access inside the scanner container.
  args.splice(2,0,'--network','none');
  const result=spawnSync('docker',args,{stdio:'inherit',timeout:120000});
  if(result.error){
    const owner=spawnSync('docker',['inspect','--format','{{index .Config.Labels "scaling.owner"}}',name],{encoding:'utf8'});
    if(owner.status===0&&owner.stdout.trim()==='ci-security')spawnSync('docker',['rm','--force',name],{stdio:'inherit'});
  }
  assert.ok(!result.error,'Owned scanner regression timed out');return result.status;
}
assert.equal(scan('clean.json'),0,'The scanner must read private source and write a clean report');
assert.deepEqual(JSON.parse(await readFile(resolve(results,'clean.json'),'utf8')),[]);
const syntheticKey=randomBytes(32).toString('hex');
await writeFile(resolve(source,'synthetic.txt'),'api_key = "'+syntheticKey+'"\n',{mode:0o600});
assert.equal(scan('synthetic-redacted.json'),1,'Default rules must still block a synthetic secret');
const redacted=await readFile(resolve(results,'synthetic-redacted.json'),'utf8');
assert.ok(!redacted.includes(syntheticKey),'Scanner evidence must not expose even synthetic credential values');
assert.ok(JSON.parse(redacted).some(row=>row.RuleID==='generic-api-key'));
console.log('SCANNER_REGRESSION_PASS private-source access, report writes, default detection and redaction');
