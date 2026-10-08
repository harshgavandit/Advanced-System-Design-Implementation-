export type LogWriteResult='written'|'capacity'|'write_failed';
type Entry={line:string;resolve:(result:LogWriteResult)=>void};
export class BoundedLogWriter{
  private queue:Entry[]=[];
  private active=0;
  private flushing:Promise<void>|undefined;
  private capacity:number;
  private batchSize:number;
  private write:(lines:string[])=>Promise<void>;
  constructor(capacity:number,batchSize:number,write:(lines:string[])=>Promise<void>){
    if(!Number.isInteger(capacity)||capacity<1||!Number.isInteger(batchSize)||batchSize<1||batchSize>capacity)throw new Error('Invalid log writer limits');
    this.capacity=capacity;this.batchSize=batchSize;this.write=write;
  }
  get pending():number{return this.queue.length+this.active;}
  enqueue(line:string):Promise<LogWriteResult>{
    if(this.pending>=this.capacity)return Promise.resolve('capacity');
    return new Promise(resolve=>this.queue.push({line,resolve}));
  }
  flush():Promise<void>{
    if(this.flushing)return this.flushing;
    this.flushing=Promise.resolve().then(async()=>{
      while(this.queue.length){
        const batch=this.queue.splice(0,this.batchSize);this.active=batch.length;
        let result:LogWriteResult='written';
        try{await this.write(batch.map(entry=>entry.line));}catch{result='write_failed';}
        this.active=0;for(const entry of batch)entry.resolve(result);
      }
    }).finally(()=>{this.flushing=undefined;});
    return this.flushing;
  }
}
