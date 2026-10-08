export type CgroupStats={cpuSeconds:number;throttledSeconds:number;throttledPeriods:number;cpuLimit?:number;memoryBytes:number;memoryLimit?:number};
export function parseCgroup(cpu:string,quota:string,memory:string,limit:string):CgroupStats{
  const numeric=(raw:string|undefined):number=>{if(!raw || !/^\d+$/.test(raw.trim()))throw new Error('Invalid cgroup value');const value=Number(raw);if(!Number.isSafeInteger(value))throw new Error('Invalid cgroup number');return value;};
  const fields=Object.fromEntries(cpu.trim().split('\n').map(row=>row.trim().split(/\s+/)));
  const [maximum,period]=quota.trim().split(/\s+/);
  const periodValue=numeric(period);if(periodValue===0)throw new Error('Invalid cgroup period');
  return {cpuSeconds:numeric(fields.usage_usec)/1e6,throttledSeconds:numeric(fields.throttled_usec)/1e6,throttledPeriods:numeric(fields.nr_throttled),cpuLimit:maximum==='max'?undefined:numeric(maximum)/periodValue,memoryBytes:numeric(memory),memoryLimit:limit.trim()==='max'?undefined:numeric(limit)};
}
