import { createHash } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../servers/02-express');
const hash=createHash('sha256');
async function walk(path,relative) {
  const entries=(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
  for(const entry of entries) {
    const name=relative+entry.name;
    if(entry.isDirectory()) await walk(resolve(path,entry.name),name+'/');
    else {hash.update(name+'\0');hash.update(await readFile(resolve(path,entry.name)));}
  }
}
await walk(resolve(root,'src'),'src/');
for(const name of ['Dockerfile','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','tsup.config.ts','runtime-packages.lock']) {hash.update(name+'\0');hash.update(await readFile(resolve(root,name)));}
process.stdout.write(hash.digest('hex')+'\n');
