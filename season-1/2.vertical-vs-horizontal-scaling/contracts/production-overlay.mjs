export function applyProductionOverlay(spec,policy,matrix) {
  spec.info.version=policy.version;
  const error={description:'Security, conflict or availability rejection',content:{'application/json':{schema:{type:'object',required:['error'],properties:{error:{type:'string'}}}}}};
  const receipt={type:'object',required:['jobId','status'],properties:{jobId:{type:'string',pattern:'^[a-f0-9]{24}$'},status:{type:'string',enum:['accepted','processing','succeeded','failed']}}};
  const response=(schema,description)=>({description,content:{'application/json':{schema}}});
  const idParameter=[{in:'path',name:'id',required:true,schema:{type:'string',pattern:'^[a-f0-9]{24}$'}}];
  const jobSchema={
    ...receipt,
    required:['jobId','status','attempts','generation','createdAt','updatedAt'],
    properties:{
      ...receipt.properties,attempts:{type:'integer',minimum:0,maximum:5},
      generation:{type:'integer',minimum:1},createdAt:{type:'string'},updatedAt:{type:'string'},
      completedAt:{type:'string'},productId:{type:'string',pattern:'^[a-f0-9]{24}$'},errorCode:{type:'string'},
    },
  };
  spec.paths['/ingestion-jobs/{id}']={get:{
    operationId:'getIngestionJob',security:[{bearerAuth:[]}],parameters:idParameter,
    responses:{200:response(jobSchema,'Owned or administrator-visible durable job'),404:error},
  }};
  spec.paths['/ingestion-jobs/{id}/redrive']={post:{
    operationId:'redriveIngestionJob',security:[{bearerAuth:[]}],parameters:idParameter,
    responses:{202:response(receipt,'Failed job redriven once; repeats return current state'),404:error},
  }};
  for (const methods of Object.values(spec.paths)) for(const operation of Object.values(methods)) {
    if (!operation.operationId) continue;
    for(const status of policy.errorStatuses) operation.responses[status]??=structuredClone(error);
    if(policy.adminOperations.includes(operation.operationId)) operation.security=[{bearerAuth:[]}];
    if(policy.mutationOperations?.includes(operation.operationId)) {
      operation.parameters??=[];
      operation.parameters.push({in:'header',name:'Idempotency-Key',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9._:-]{1,128}$'}});
    }
    if(operation.operationId==='refresh') {
      let schema=operation.responses['200'].content['application/json'].schema;
      if(schema.$ref) schema=spec.components.schemas[schema.$ref.split('/').at(-1)];
      schema.required=policy.refreshRequiredFields;
      schema.properties.refreshToken={type:'string'};
    }
    if(operation.operationId==='ingestProduct') {
      operation.parameters=[{in:'header',name:'Idempotency-Key',required:true,schema:{type:'string',pattern:'^[A-Za-z0-9._:-]{1,128}$'}}];
      operation.responses['202']=response({...receipt,properties:{...receipt.properties,status:{type:'string',enum:['accepted']}}},'Majority-committed durable acceptance receipt');
    }
    if(operation.operationId==='getIngestStats') {
      const fields=['accepted','queued','flushed','failed','unsent','oldestPendingSeconds'];
      operation.responses['200']=response({type:'object',required:fields,properties:Object.fromEntries(fields.map(key=>[key,{type:'number',minimum:0}]))},'Shared durable counters, not process-local statistics');
    }
  }
  matrix.implementations.express.supported.push('getIngestionJob','redriveIngestionJob');
  return {spec,matrix};
}
