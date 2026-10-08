const allowed=new Set(['http.request.method','http.method','http.response.status_code','http.status_code','http.route','db.operation.name','db.system','db.system.name','db.collection.name','messaging.system','messaging.operation.type','ingestion.generation']);
export function safeTraceAttributes(attributes:Record<string,unknown>):Record<string,string|number|boolean>{
  return Object.fromEntries(Object.entries(attributes).filter(([key,value])=>allowed.has(key) && (typeof value==='number'&&Number.isFinite(value) || typeof value==='boolean' || typeof value==='string'&&value.length<=120&&!value.includes('@')))) as Record<string,string|number|boolean>;
}
export function validTraceParent(value:unknown):value is string{
  return typeof value==='string' && /^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-0[01]$/.test(value);
}
