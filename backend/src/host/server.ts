import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {timingSafeEqual} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {join} from 'node:path';
import {HostManager} from './manager.js';
import {encodeFrame,decodeFrame} from '../shared/wire.js';
import {forwardBounded} from '../shared/transport.js';
import {safeError,type HostConfig,type Rpc} from '../shared/types.js';
export async function createHostServer(config:HostConfig,manager=new HostManager(config)){
 const app=Fastify({logger:false,bodyLimit:32768});await app.register(websocket,{options:{maxPayload:65536}});
 app.post('/hook',async(req,reply)=>{const token=(req.headers.authorization??'').replace(/^Bearer /,'');try{return await manager.hook(token,req.body);}catch(error){return reply.code(403).send({error:safeError(error)});}});
 app.get('/ipc',{websocket:true,preValidation:async(req,reply)=>{
  const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+config.ipcToken);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({error:'Unauthorized'});
 }},socket=>{
  const send=(message:Record<string,unknown>)=>{const frame=encodeFrame(message);forwardBounded(socket,frame,typeof frame!=='string');};
  let inflight=0;
  const listener=(event:any)=>send(event);manager.on('event',listener);
  socket.on('message',(raw,binary)=>{if(inflight>=64){socket.close(1013,'Request queue full');return;}let rpc:Rpc;try{rpc=decodeFrame(raw,binary);if(rpc.type!=='rpc'||typeof rpc.requestId!=='string'||rpc.requestId.length>200||typeof rpc.clientId!=='string'||rpc.clientId.length>200||typeof rpc.method!=='string'||!rpc.params||typeof rpc.params!=='object'||Array.isArray(rpc.params))throw Error();}catch{socket.close(1008,'Invalid RPC');return;}
   inflight++;void manager.rpc(rpc).then(result=>send({type:'result',requestId:rpc.requestId,result})).catch(error=>send({type:'result',requestId:rpc.requestId,error:safeError(error)})).finally(()=>{inflight--;});
  });
  socket.on('close',()=>manager.off('event',listener));socket.on('error',()=>{});
 });
 app.addHook('onClose',async()=>{await manager.close();});return {app,manager};
}
export async function listenHost(config:HostConfig){const {app,manager}=await createHostServer(config);const path=join(manager.store.dir,'host.sock');await app.listen({path});chmodSync(path,0o600);return {app,manager};}
