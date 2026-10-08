export function durationSeconds(value) {
  if (typeof value !== 'string') throw new TypeError('An explicit workload duration is required');
  const parts=[...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (!parts.length || parts.map(part=>part[0]).join('')!==value) throw new RangeError('Invalid workload duration');
  const units={ms:0.001,s:1,m:60,h:3600};
  const total=parts.reduce((sum,part)=>sum+Number(part[1])*units[part[2]],0);
  if (!Number.isFinite(total) || total<=0) throw new RangeError('Workload duration must be positive');
  return total;
}
export function profileDurationSeconds(profile) {
  return profile.duration ? durationSeconds(profile.duration) : profile.stages.reduce((sum,stage)=>sum+durationSeconds(stage.duration),0);
}
