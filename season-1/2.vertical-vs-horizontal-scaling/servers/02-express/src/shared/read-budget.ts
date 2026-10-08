export class ReadBudget {
  private readonly limit:number;
  private active=0;
  constructor(limit:number){if(!Number.isSafeInteger(limit)||limit<1)throw new Error('Invalid read budget');this.limit=limit;}
  async run<T>(work:()=>Promise<T>):Promise<T>{
    if(this.active>=this.limit)throw Object.assign(new Error('Read capacity is busy; retry later'),{status:503});
    this.active++;
    try{return await work();}finally{this.active--;}
  }
}
export function cacheRemainingMs(startedAt:number,now:number,random:number):number{
  const ttl=24000+Math.floor(Math.min(1,Math.max(0,random))*6000);
  return Math.max(0,ttl-Math.max(0,now-startedAt));
}
