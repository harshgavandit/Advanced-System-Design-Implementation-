import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,copyFile,readFile,realpath,lstat,writeFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const topic=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),repo=resolve(topic,'../..'),results=resolve(topic,'infra/compose/artifacts/ci');
await mkdir(results,{recursive:true});const snapshot=await mkdtemp(resolve(results,'source-'));
const archive=resolve(results,'ci-image.tar'),identity=JSON.parse(await readFile(resolve(results,'image-identity.json'),'utf8'));
const digest=createHash('sha256');for await(const chunk of createReadStream(archive))digest.update(chunk);
assert.equal(digest.digest('hex'),identity.archiveSha256,'Do not scan or release a substituted image archive');assert.equal(identity.durabilityPassed,true);
const currentSource=spawnSync(process.execPath,[resolve(topic,'scripts/local/source-hash.mjs')],{encoding:'utf8'});
assert.equal(currentSource.status,0);assert.equal(currentSource.stdout.trim(),identity.sourceTreeSha256,'Scan the image built and tested from this source, not stale local evidence');
const inventory=spawnSync('git',['-c','safe.directory='+repo.replaceAll('\\','/'),'ls-files','-z','--cached','--others','--exclude-standard'],{cwd:repo,encoding:'utf8'});assert.equal(inventory.status,0);
for(const path of inventory.stdout.split('\0').filter(Boolean)){
  if(!path.startsWith('season-1/2.vertical-vs-horizontal-scaling/')&&!path.startsWith('.github/workflows/vertical-scaling-'))continue;
  if(/(^|\/)(node_modules|artifacts|dist|logs|\.env[^/]*)(\/|$)/.test(path))continue;
  if(!/\.(ts|js|mjs|json|yaml|yml|ps1|sh|toml|lock|tf|hcl|example)$/.test(path)&&!path.endsWith('/Dockerfile'))continue;
  let source;try{const entry=await lstat(resolve(repo,path));assert.ok(entry.isFile()&&!entry.isSymbolicLink(),'Do not copy linked source or ignored local credentials through a source link');source=await realpath(resolve(repo,path));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const inside=relative(repo,source);assert.ok(!inside.startsWith('..')&&!isAbsolute(inside),'Do not follow source links outside this repository');
  const target=resolve(snapshot,path);await mkdir(dirname(target),{recursive:true});await copyFile(source,target);
}
const tools={gitleaks:'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f',hadolint:'hadolint/hadolint@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d',syft:'ghcr.io/anchore/syft@sha256:0356562f495d432056237fbea5cbc2d4839c9c75cd500784a66de2e7cc95ca7c',grype:'ghcr.io/anchore/grype@sha256:5c88961f4130e830542d441c7ed6c78baa28e799163abac53d2be4923fb5ab7d'};
const cache=resolve(results,'grype-cache');await mkdir(cache,{recursive:true});
const scratch=await mkdtemp(resolve(results,'scan-temp-'));
function scan(image,args,{input,allowFindings=false}={}){
  const name='scaling-ci-scan-'+randomBytes(8).toString('hex');
  const result=spawnSync('docker',['run','--rm','--name',name,'--label','scaling.owner=ci-security','--cpus=1','--memory=1g','--cap-drop=ALL','--security-opt=no-new-privileges:true','--read-only','-v',scratch+':/tmp','-v',snapshot+':/src:ro','-v',results+':/results','-v',cache+':/cache','-e','HOME=/tmp','-e','SEMGREP_SEND_METRICS=off','-e','XDG_CACHE_HOME=/cache','-e','GRYPE_DB_CACHE_DIR=/cache',...(input?['-i']:[]),image,...args],{encoding:'utf8',input,timeout:20*60*1000,stdio:input?['pipe','inherit','inherit']:'inherit'});
  if(result.error){
    // Killing the CLI on timeout does not necessarily stop its container.
    const owner=spawnSync('docker',['inspect','--format','{{index .Config.Labels "scaling.owner"}}',name],{encoding:'utf8'});
    if(owner.status===0&&owner.stdout.trim()==='ci-security')spawnSync('docker',['rm','--force',name],{stdio:'inherit'});
  }
  assert.ok(!result.error,'Security scan could not complete within its bounded runtime');
  assert.ok(result.status===0||(allowFindings&&result.status===2),'Security scan failed; do not bypass findings or an unavailable database');
  return result.status;
}
scan(tools.gitleaks,['dir','/src','--redact','--report-format','json','--report-path','/results/secrets-redacted.json']);
scan(tools.hadolint,['/bin/hadolint','--failure-threshold','warning','-'],{input:await readFile(resolve(topic,'servers/02-express/Dockerfile'),'utf8')});
scan('rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667',['-color',...['ci','release','deploy'].map(name=>'/src/.github/workflows/vertical-scaling-'+name+'.yml')]);
const semgrep='semgrep/semgrep@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b';
scan(semgrep,['semgrep','--test','--metrics=off','--disable-version-check','/src/season-1/2.vertical-vs-horizontal-scaling/scripts/ci/sast']);
scan(semgrep,['semgrep','scan','--metrics=off','--disable-version-check','--strict','--error','--config','/src/season-1/2.vertical-vs-horizontal-scaling/scripts/ci/sast/rules.yml','--json','--output','/results/sast.json','/src/season-1/2.vertical-vs-horizontal-scaling/servers/02-express/src']);
scan(tools.syft,['docker-archive:/results/ci-image.tar','-o','spdx-json=/results/image-sbom.spdx.json']);
const vulnerabilityStatus=scan(tools.grype,['docker-archive:/results/ci-image.tar','--fail-on','high','-o','json','--file','/results/image-vulnerabilities.json'],{allowFindings:true});
const vulnerabilities=JSON.parse(await readFile(resolve(results,'image-vulnerabilities.json'),'utf8'));
const counts={};for(const match of vulnerabilities.matches)counts[match.vulnerability.severity]=(counts[match.vulnerability.severity]??0)+1;
await writeFile(resolve(results,'security-summary.json'),JSON.stringify({at:new Date().toISOString(),passed:vulnerabilityStatus===0,imageId:identity.imageId,sourceTreeSha256:identity.sourceTreeSha256,archiveSha256:identity.archiveSha256,matchCounts:counts,database:vulnerabilities.descriptor.db,threshold:'High',exceptions:[]},null,2)+'\n');
assert.equal(vulnerabilityStatus,0,'Release blocked by high/critical findings; no automatic exceptions');
console.log('CI_SECURITY_PASS exact tested image archive, redacted source scan, Dockerfile lint, vulnerability gate and SBOM');
