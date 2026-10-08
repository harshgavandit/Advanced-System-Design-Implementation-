import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
export function mongoPoolBudget(input={}){
  const defaults={apiTasks:4,apiWorkers:1,workerTasks:1,relayTasks:1,members:1,overlap:1,apiPool:10,workerPool:3,relayPool:2,reserve:0.2};
  for(const key of Object.keys(input))if(!Object.hasOwn(defaults,key))throw new Error(`Unknown ${key}`);
  const options={...defaults,...input};
  for(const [key,value] of Object.entries(options)){
    if(key==='reserve'){if(!Number.isFinite(value)||value<0||value>=1)throw new Error('Invalid reserve');continue;}
    if(!Number.isSafeInteger(value)||value<(['workerTasks','relayTasks'].includes(key)?0:1))throw new Error(`Invalid ${key}`);
  }
  const apiClients=options.apiTasks*options.apiWorkers*options.overlap;
  const clients=apiClients+options.workerTasks+options.relayTasks;
  const traffic=apiClients*options.apiPool+options.workerTasks*options.workerPool+options.relayTasks*options.relayPool;
  const perServerUpperBound=traffic+clients*2;
  return {configuredInputs:options,apiServingProcesses:apiClients,perServerUpperBound,primaryOnlyClusterUpperBound:traffic+clients*2*options.members,allPoolsClusterUpperBound:perServerUpperBound*options.members,minimumPerServerWithReserve:Math.ceil(perServerUpperBound/(1-options.reserve)),interpretation:'Configured upper bounds including two monitoring sockets per client per member, not measured open connections. Provider limits must be checked per server, not only per cluster.'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const input=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,value]=arg.replace(/^--/,'').split('=');return [key,Number(value)];}));
  console.log(JSON.stringify(mongoPoolBudget(input),null,2));
}
