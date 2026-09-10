import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {decodeFrame} from '../../src/shared/wire.js';
import {SecureChannel,type FingerprintStore} from '../../../frontend/src/secureChannel.ts';

class Pins implements FingerprintStore{
  values=new Map<string,string>();
  get(id:string){return this.values.get(id)??null}
  set(id:string,value:string){this.values.set(id,value)}
}

export async function createEncryptedClient(f:{port:number;origin:string;config:{hostId:string}},name='本地用户'){
  const login=await fetch(`http://127.0.0.1:${f.port}/auth/dev`,{method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:JSON.stringify({name})});assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0],auth:any=await login.json(),events:any[]=[],frames:string[]=[],pending=new Map<string,{resolve:(value:any)=>void;reject:(error:any)=>void}>(),pins=new Pins();
  let socket:WebSocket,clientId=randomUUID(),channel:SecureChannel|undefined,opening:Promise<SecureChannel>|undefined,receive=Promise.resolve();
  const send=(value:unknown)=>{const frame=JSON.stringify(value);frames.push(frame);socket.send(frame)};
  async function connect(){
    clientId=randomUUID();channel=undefined;opening=undefined;socket=new WebSocket(`ws://127.0.0.1:${f.port}/ws/browser?clientId=${clientId}`,{headers:{origin:f.origin,cookie}});
    socket.on('message',(raw,binary)=>{const visible=Buffer.isBuffer(raw)?raw.toString():String(raw);frames.push(visible);receive=receive.then(async()=>{const message=decodeFrame(raw,binary);if(message.type==='channel_opened'){/* Integration clients model a user who explicitly accepted this fixture Host. */if(!pins.get(f.config.hostId))pins.set(f.config.hostId,message.hello.fingerprint);await channel!.complete(message.hello);return}if(message.type==='sealed_result'){const value=await channel!.open(message.cipher),item=pending.get(value.id);if(item){pending.delete(value.id);value.error?item.reject(value.error):item.resolve(value.result)}return}if(message.type==='sealed_event'){events.push(await channel!.open(message.cipher));return}if(message.type==='event'&&message.host?.online===false){channel=undefined;opening=undefined;events.push(message);return}if(message.type==='response'){const item=pending.get(message.id);if(item){pending.delete(message.id);item.reject(message.error)}if(['CHANNEL_NOT_FOUND','UNAUTHORIZED'].includes(message.error?.code)){channel=undefined;opening=undefined}}})});
    socket.on('error',()=>{});await new Promise<void>((resolve,reject)=>{socket.once('open',()=>resolve());socket.once('error',reject)});
  }
  async function ensure(){
    if(channel&&opening)return opening;channel=await SecureChannel.begin(f.config.hostId,randomUUID(),pins);
    opening=new Promise<SecureChannel>((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>reject(new Error('channel timeout')),5000);const handler=(raw:WebSocket.RawData)=>{const message=decodeFrame(raw);if(message.type==='channel_opened'&&message.id===id){socket.off('message',handler);void receive.then(()=>{clearTimeout(timer);resolve(channel!)})}else if(message.type==='response'&&message.id===id){socket.off('message',handler);clearTimeout(timer);reject(message.error)}};socket.on('message',handler);send({type:'open_channel',id,hostId:f.config.hostId,channelId:channel!.channelId,clientPublicKey:channel!.hello.clientPublicKey})});return opening;
  }
  await connect();
  return {events,frames,cookie,auth,reconnect:connect,close:()=>socket.close(),call:async(method:string,params:Record<string,unknown>={})=>{const secure=await ensure(),id=randomUUID(),body={operationId:randomUUID(),...params},cipher=await secure.seal({type:'request',id,method,params:body});return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method))},8000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});send({type:'sealed',id,hostId:f.config.hostId,channelId:secure.channelId,cipher})})}};
}
