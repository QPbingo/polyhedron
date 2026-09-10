import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,RpcClient} from '../src/api.ts';
import {accept,testIdentity} from './channel-fixture.ts';
class Socket {
 static OPEN=1;static current:Socket;readyState=1;bufferedAmount=0;onopen:()=>void=()=>{};onclose:()=>void=()=>{};onerror:()=>void=()=>{};onmessage:(event:{data:string})=>void=()=>{};sent:string[]=[];
 constructor(_url:string){Socket.current=this}send(data:string){this.sent.push(data)}close(code?:number){if(code!==undefined&&code!==1000&&(code<3000||code>4999))throw new DOMException('Invalid close code','InvalidAccessError');this.readyState=3;this.onclose()}
}
async function until(check:()=>boolean){const end=Date.now()+2000;while(!check()){if(Date.now()>end)throw new Error('timeout');await new Promise(resolve=>setTimeout(resolve,5))}}
test('RPC seals content, bounds pending work and never replays rejected requests',async()=>{
 const originalSocket=globalThis.WebSocket,originalLocation=globalThis.location,storage=new Map<string,string>(),originalStorage=globalThis.localStorage;
 Object.assign(globalThis,{WebSocket:Socket,location:{protocol:'http:',host:'127.0.0.1'},localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)}});
 const rpc=new RpcClient();try{
  rpc.connect();const socket=Socket.current;socket.onopen();const opening=rpc.openHost('h');await until(()=>socket.sent.length===1);const open=JSON.parse(socket.sent[0]),host=accept(testIdentity(),{v:1,hostId:'h',channelId:open.channelId,clientPublicKey:open.clientPublicKey});storage.set('polyhedron.host-fingerprint.h',host.hello.fingerprint);socket.onmessage({data:JSON.stringify({type:'channel_opened',id:open.id,hostId:'h',channelId:open.channelId,hello:host.hello})});await opening;
  const pending=Array.from({length:64},()=>rpc.request('h','input',{data:'PRIVATE_INPUT'}).catch(error=>error));await assert.rejects(rpc.request('h','input',{data:'overflow'}),{code:'BACKPRESSURE'});await until(()=>socket.sent.length===65);
  for(const raw of socket.sent.slice(1)){assert.equal(raw.includes('PRIVATE_INPUT'),false);const envelope=JSON.parse(raw),request=host.channel.open(envelope.cipher);socket.onmessage({data:JSON.stringify({type:'sealed_result',id:envelope.id,hostId:'h',channelId:open.channelId,cipher:host.channel.seal({type:'response',id:request.id,result:{ok:true}})})})}
  await Promise.all(pending);socket.bufferedAmount=2*1024*1024;await assert.rejects(rpc.request('h','input',{data:'overflow'}),{code:'BACKPRESSURE'});assert.equal(socket.sent.length,65);
  rpc.close();await assert.rejects(rpc.request('h','input',{data:'offline'}),{code:'OFFLINE'});assert.equal(socket.sent.length,65);
 }finally{rpc.close();Object.assign(globalThis,{WebSocket:originalSocket,location:originalLocation,localStorage:originalStorage})}
});

test('RPC rejects a changed Host identity without leaving the channel promise pending',async()=>{
 const originalSocket=globalThis.WebSocket,originalLocation=globalThis.location,originalStorage=globalThis.localStorage,storage=new Map([['polyhedron.host-fingerprint.h','different-host']]);
 Object.assign(globalThis,{WebSocket:Socket,location:{protocol:'http:',host:'127.0.0.1'},localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)}});
 const rpc=new RpcClient();try{
  rpc.connect();const socket=Socket.current;socket.onopen();const opening=rpc.openHost('h');await until(()=>socket.sent.length===1);const open=JSON.parse(socket.sent[0]),host=accept(testIdentity(),{v:1,hostId:'h',channelId:open.channelId,clientPublicKey:open.clientPublicKey});socket.onmessage({data:JSON.stringify({type:'channel_opened',id:open.id,hostId:'h',channelId:open.channelId,hello:host.hello})});
  await assert.rejects(opening,(error:any)=>error instanceof ApiError&&error.code==='HOST_IDENTITY_CHANGED');assert.equal(rpc.channelId('h'),null);
 }finally{rpc.close();Object.assign(globalThis,{WebSocket:originalSocket,location:originalLocation,localStorage:originalStorage})}
});

test('trusting a verified Host immediately creates a fresh usable connection',async()=>{
 const originalSocket=globalThis.WebSocket,originalLocation=globalThis.location,originalStorage=globalThis.localStorage,storage=new Map<string,string>(),identity=testIdentity();
 Object.assign(globalThis,{WebSocket:Socket,location:{protocol:'http:',host:'127.0.0.1'},localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)}});
 const rpc=new RpcClient();try{
  rpc.connect();const first=Socket.current;first.onopen();const untrusted=rpc.openHost('h');await until(()=>first.sent.length===1);const firstOpen=JSON.parse(first.sent[0]),firstHost=accept(identity,{v:1,hostId:'h',channelId:firstOpen.channelId,clientPublicKey:firstOpen.clientPublicKey});first.onmessage({data:JSON.stringify({type:'channel_opened',id:firstOpen.id,hostId:'h',channelId:firstOpen.channelId,hello:firstHost.hello})});await assert.rejects(untrusted,(error:any)=>error.code==='HOST_TRUST_REQUIRED');
  rpc.trustHost('h',firstHost.hello.fingerprint);const second=Socket.current;assert.notEqual(second,first);second.onopen();const response=rpc.request<{ok:boolean}>('h','list');await until(()=>second.sent.length===1);const secondOpen=JSON.parse(second.sent[0]),secondHost=accept(identity,{v:1,hostId:'h',channelId:secondOpen.channelId,clientPublicKey:secondOpen.clientPublicKey});second.onmessage({data:JSON.stringify({type:'channel_opened',id:secondOpen.id,hostId:'h',channelId:secondOpen.channelId,hello:secondHost.hello})});await until(()=>second.sent.length===2);const envelope=JSON.parse(second.sent[1]),request=secondHost.channel.open(envelope.cipher);second.onmessage({data:JSON.stringify({type:'sealed_result',id:envelope.id,hostId:'h',channelId:secondOpen.channelId,cipher:secondHost.channel.seal({type:'response',id:request.id,result:{ok:true}})})});assert.deepEqual(await response,{ok:true});
 }finally{rpc.close();Object.assign(globalThis,{WebSocket:originalSocket,location:originalLocation,localStorage:originalStorage})}
});
