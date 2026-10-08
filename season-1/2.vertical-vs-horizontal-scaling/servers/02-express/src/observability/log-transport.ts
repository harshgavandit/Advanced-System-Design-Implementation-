import {createSocket} from 'node:dgram';
const target=process.env.LOG_UDP_ENDPOINT;
const socket=target?createSocket('udp4'):undefined;
socket?.unref();socket?.on('error',()=>{});
export function sendOperationalLog(event:Record<string,unknown>):void{
  if(!socket || !target)return;
  const [host,port]=target.split(':');
  if(host!=='telemetry' || port!=='1514')return;
  const body=Buffer.from(JSON.stringify(event));
  if(body.byteLength>4096)return;
  socket.send(body,1514,host,()=>{});
}
