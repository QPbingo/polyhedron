import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {timingSafeEqual} from 'node:crypto';
import {chmodSync} from 'node:fs';
import {join} from 'node:path';
import {jwtVerify} from 'jose';
import {HostManager} from './manager.js';
import {HostChannel,HostIdentity,type ChannelHello,type SealedFrame} from './channel.js';
import {decodeFrame,encodeFrame} from '../shared/wire.js';
import {forwardBounded} from '../shared/transport.js';
import {Fault,safeError,type HostConfig} from '../shared/types.js';

type ActiveChannel={clientId:string;actorId:string;expires:number;channel:HostChannel};
const validId=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(value);

export async function createHostServer(config:HostConfig,manager=new HostManager(config)){
 const app=Fastify({logger:false,bodyLimit:32768});await app.register(websocket,{options:{maxPayload:8*1024*1024,perMessageDeflate:false}});
 const identity=HostIdentity.loadOrCreate({dataDir:manager.store.dir,hostId:config.hostId,secret:config.masterKey,legacySecret:config.legacyMasterKey});
 app.post('/hook',async(req,reply)=>{const token=(req.headers.authorization??'').replace(/^Bearer /,'');try{return await manager.hook(token,req.body);}catch(error){return reply.code(403).send({error:safeError(error)});}});
 app.get('/ipc',{websocket:true,preValidation:async(req,reply)=>{
  const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+config.ipcToken);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({error:'Unauthorized'});
 }},socket=>{
  const channels=new Map<string,ActiveChannel>(),openingChannels=new Map<string,{clientId:string;cancelled:boolean}>();let inflight=0,closed=false;
  const send=(message:Record<string,unknown>)=>{const frame=encodeFrame(message);return forwardBounded(socket,frame,typeof frame!=='string')};
  const verifyGrant=async(message:any,opening:boolean)=>{let payload:any;try{({payload}=await jwtVerify(message.grant,new TextEncoder().encode(config.hostToken),{algorithms:['HS256'],subject:config.accountId,audience:`polyhedron-host:${config.hostId}`}))}catch{throw new Fault('UNAUTHORIZED','端到端通道授权已失效')}const hello=message.hello as ChannelHello|undefined;if(payload.hostId!==config.hostId||payload.clientId!==message.clientId||payload.clientInstanceId!==message.clientId||typeof payload.deviceId!=='string'||!/^[0-9a-f]{64}$/.test(payload.deviceId)||payload.channelId!==message.channelId||payload.scope!=='channel'||payload.purpose!=='channel'||typeof payload.exp!=='number'||payload.exp*1000>Date.now()+31000||(opening&&payload.clientPublicKey!==hello?.clientPublicKey))throw new Fault('UNAUTHORIZED','端到端通道授权不匹配');return {expires:payload.exp*1000,actorId:payload.deviceId as string}};
  const fail=(message:any,error:unknown)=>send({type:'channel_error',requestId:message.requestId,clientId:message.clientId,channelId:message.channelId,error:safeError(error)});
  const listener=(event:any)=>{const targets=event.channelId?[channels.get(event.channelId)]:[...channels.values()];for(const target of targets){if(!target||target.expires<=Date.now())continue;const channelId=event.channelId??[...channels].find(([,value])=>value===target)?.[0];if(!channelId)continue;try{send({type:'sealed_event',clientId:target.clientId,channelId,cipher:target.channel.seal(event)})}catch{/* A failed transport will close and release every channel. */}}};manager.on('event',listener);
  socket.on('message',(raw,binary)=>{if(inflight>=64){socket.close(1013,'Request queue full');return}let message:any;try{message=decodeFrame(raw,binary);if(!message||typeof message!=='object'||!validId(message.clientId)||!validId(message.channelId))throw new Error()}catch{socket.close(1008,'Invalid channel envelope');return}
   inflight++;void(async()=>{
    if(message.type==='channel_open'){
      if(!validId(message.requestId)||message.hello?.v!==1||message.hello?.hostId!==config.hostId||message.hello?.channelId!==message.channelId||typeof message.hello?.clientPublicKey!=='string')throw new Fault('INVALID_CHANNEL','通道握手无效');if(channels.has(message.channelId)||openingChannels.has(message.channelId))throw new Fault('CHANNEL_EXISTS','通道标识已存在');if(channels.size+openingChannels.size>=256)throw new Fault('CHANNEL_LIMIT','主机安全通道数量已达上限');const opening={clientId:message.clientId,cancelled:false};openingChannels.set(message.channelId,opening);try{const {expires,actorId}=await verifyGrant(message,true),accepted=HostChannel.accept(identity,message.hello);await manager.openChannel(message.channelId,expires,actorId);if(closed||opening.cancelled){await manager.closeChannel(message.clientId,message.channelId);return}channels.set(message.channelId,{clientId:message.clientId,actorId,expires,channel:accepted.channel});if(!send({type:'channel_opened',requestId:message.requestId,clientId:message.clientId,channelId:message.channelId,hello:accepted.hello})){channels.delete(message.channelId);await manager.closeChannel(message.clientId,message.channelId)}return}finally{openingChannels.delete(message.channelId)}
    }
    if(message.type==='channel_renew'){const active=channels.get(message.channelId);if(!active||active.clientId!==message.clientId)throw new Fault('CHANNEL_NOT_FOUND','通道不存在');const {expires,actorId}=await verifyGrant(message,false);if(actorId!==active.actorId)throw new Fault('UNAUTHORIZED','端到端通道授权身份不匹配');await manager.renewChannel(message.channelId,expires);active.expires=expires;return}
    if(message.type==='channel_close'){const opening=openingChannels.get(message.channelId);if(opening&&opening.clientId===message.clientId)opening.cancelled=true;const active=channels.get(message.channelId);if(active?.clientId===message.clientId){channels.delete(message.channelId);await manager.closeChannel(message.clientId,message.channelId)}return}
    if(message.type==='sealed'){
      if(!validId(message.requestId))throw new Fault('INVALID_CHANNEL','请求路由标识无效');const active=channels.get(message.channelId);if(!active||active.clientId!==message.clientId||active.expires<=Date.now())throw new Fault('UNAUTHORIZED','端到端通道已失效');let request:any;try{request=active.channel.open(message.cipher as SealedFrame)}catch(error){channels.delete(message.channelId);await manager.closeChannel(message.clientId,message.channelId);throw error}if(request?.type!=='request'||!validId(request.id)||typeof request.method!=='string'||request.method.length>100||!request.params||typeof request.params!=='object'||Array.isArray(request.params))throw new Fault('INVALID_REQUEST','加密请求正文无效');let response:any;try{response={type:'response',id:request.id,result:await manager.secureRpc(message.clientId,message.channelId,request.id,request.method,request.params,active.expires)}}catch(error){response={type:'response',id:request.id,error:safeError(error)}}send({type:'sealed_result',requestId:message.requestId,clientId:message.clientId,channelId:message.channelId,cipher:active.channel.seal(response)});return;
    }
    throw new Fault('INVALID_CHANNEL','不支持的通道消息');
   })().catch(error=>fail(message,error)).finally(()=>{inflight--});
  });
  const expiryTimer=setInterval(()=>{const time=Date.now();for(const [channelId,channel]of channels)if(channel.expires<=time){channels.delete(channelId);void manager.closeChannel(channel.clientId,channelId)}},5000);expiryTimer.unref();const teardown=()=>{if(closed)return;closed=true;clearInterval(expiryTimer);manager.off('event',listener);for(const opening of openingChannels.values())opening.cancelled=true;for(const [channelId,channel]of channels)void manager.closeChannel(channel.clientId,channelId);channels.clear()};socket.on('close',teardown);socket.on('error',()=>{});
 });
 app.addHook('onClose',async()=>{await manager.close()});return {app,manager};
}
export async function listenHost(config:HostConfig){const {app,manager}=await createHostServer(config);const path=join(manager.store.dir,'host.sock');await app.listen({path});chmodSync(path,0o600);return {app,manager};}
