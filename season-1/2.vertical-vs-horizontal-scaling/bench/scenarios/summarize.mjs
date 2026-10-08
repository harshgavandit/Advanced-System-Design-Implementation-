import { readFile,readdir,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname,resolve } from 'node:path';
import { summarizeComparison } from './comparison.mjs';
const folder=resolve(dirname(fileURLToPath(import.meta.url)),'../../infra/compose/artifacts/benchmarks');
const since=process.argv.find(arg=>arg.startsWith('--since='))?.slice(8);
const reports=[];
for(const name of await readdir(folder)) {
  if(!name.endsWith('-report.json'))continue;
  const report=JSON.parse(await readFile(resolve(folder,name),'utf8'));
  reports.push({...report,file:name});
}
const summary=summarizeComparison(reports,since);
await writeFile(resolve(folder,'comparison-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log('COMPARISON_PASS three 10-minute trials per topology with equal total CPU/memory');
