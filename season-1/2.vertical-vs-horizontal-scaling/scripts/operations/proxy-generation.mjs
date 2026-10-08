import assert from 'node:assert/strict';

export function nginxWorkerPids(output){
  return output.split(/\r?\n/).flatMap(line=>{
    const match=line.trim().match(/^(\d+)\s+nginx:\s+worker process(?:\s|$)/);
    return match?[match[1]]:[];
  });
}

export function generationDrained(previous,current){
  assert.ok(previous.length>0,'Capture the serving nginx generation before reloading');
  return current.length>0&&previous.every(pid=>!current.includes(pid));
}
