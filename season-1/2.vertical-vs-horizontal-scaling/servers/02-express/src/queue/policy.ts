export function assertQueuePolicy(source:Record<string,string|undefined>,dead:Record<string,string|undefined>,local:boolean):{retentionSupported:boolean} {
  const redrive=JSON.parse(source.RedrivePolicy || '{}') as {maxReceiveCount?:number|string;deadLetterTargetArn?:string};
  const retentionSupported=source.MessageRetentionPeriod!==undefined && dead.MessageRetentionPeriod!==undefined;
  const sourceRetention=source.MessageRetentionPeriod==='345600' || (local && source.MessageRetentionPeriod===undefined);
  const deadRetention=dead.MessageRetentionPeriod==='1209600' || (local && dead.MessageRetentionPeriod===undefined);
  if (source.VisibilityTimeout!=='60' || !sourceRetention || !deadRetention || Number(redrive.maxReceiveCount)!==5 || !dead.QueueArn || redrive.deadLetterTargetArn!==dead.QueueArn) throw new Error('SQS policy does not match the ingestion contract');
  return {retentionSupported};
}
