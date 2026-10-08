import {createServer} from 'node:http';
if(process.env.FAIL_STARTUP==='true')process.exit(1);
// Fault-injection fixture: readiness is healthy but business content is wrong.
createServer((req,res)=>{res.setHeader('content-type','application/json');if(['/health','/ready'].includes(req.url)){res.end('{"status":"ok"}');return;}res.end('{"items":[],"totalItems":0}');}).listen(5002,'0.0.0.0');
