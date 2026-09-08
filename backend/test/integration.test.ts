import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {createFixture,until} from './fixtures/setup.js';
import {decodeFrame} from '../src/shared/wire.js';
async function client(f:any,name='本地用户'){
 const login=await fetch(`http://127.0.0.1:${f.port}/auth/dev`,{method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:JSON.stringify({name})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0],auth:any=await login.json();
 const events:any[]=[],pending=new Map<string,{resolve:(v:any)=>void,reject:(e:any)=>void}>();let socket:WebSocket;
 async function connect(){socket=new WebSocket(`ws://127.0.0.1:${f.port}/ws/browser?clientId=${randomUUID()}`,{headers:{origin:f.origin,cookie}});socket.on('message',(raw,binary)=>{const message=decodeFrame(raw,binary);if(message.type==='event')events.push(message);if(message.type==='response'){const p=pending.get(message.id);if(p){pending.delete(message.id);if(message.error)p.reject(message.error);else p.resolve(message.result);}}});socket.on('error',()=>{});await new Promise<void>((resolve,reject)=>{socket.once('open',()=>resolve());socket.once('error',reject);});}
 await connect();
 return {events,cookie,auth,reconnect:connect,close:()=>socket.close(),call:(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout '+method));},8000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});socket.send(JSON.stringify({type:'request',id,hostId:f.config.hostId,method,params}));})};
}
test('real relay + connector + host preserve PTY across takeover, connector/relay restart and reject foreign account',async()=>{
 const f=await createFixture(),a=await client(f),b=await client(f),other=await client(f,'another account');
 try{
  const folders=await a.call('listDirectories');assert.ok(folders.entries.length>0);await assert.rejects(other.call('listDirectories'),(e:any)=>e.code==='HOST_NOT_FOUND');
  const id=f.session.id;await a.call('attach',{sessionId:id});const owner=await a.call('claimControl',{sessionId:id,runtimeEpoch:f.session.runtimeEpoch});
  await a.call('resize',{sessionId:id,runtimeEpoch:owner.runtimeEpoch,controlEpoch:owner.controlEpoch,cols:92,rows:27});
  await a.call('input',{sessionId:id,runtimeEpoch:owner.runtimeEpoch,controlEpoch:owner.controlEpoch,inputSeq:1,data:'first marker\r'});
  await until(()=>a.events.some(e=>e.event==='output'&&e.data.includes('ACK:first marker')));
  await assert.rejects(other.call('attach',{sessionId:id}),(e:any)=>e.code==='HOST_NOT_FOUND');
  await b.call('attach',{sessionId:id});const next=await b.call('claimControl',{sessionId:id,runtimeEpoch:f.session.runtimeEpoch});
  await assert.rejects(a.call('input',{sessionId:id,runtimeEpoch:owner.runtimeEpoch,controlEpoch:owner.controlEpoch,inputSeq:2,data:'MUST NOT SEND\r'}),(e:any)=>e.code==='STALE_CONTROL');
  a.close();await f.restartConnector();const snapshot=await b.call('attach',{sessionId:id});assert.equal(snapshot.session.runtimeEpoch,f.session.runtimeEpoch);assert.match(snapshot.data,/ACK:first marker/);assert.equal(snapshot.session.processState,'running');
  await f.restartRelay();await b.reconnect();const after=await b.call('attach',{sessionId:id});assert.equal(after.session.runtimeEpoch,f.session.runtimeEpoch);assert.match(after.data,/ACK:first marker/);assert.doesNotMatch(after.data,/MUST NOT SEND/);
  const third=await b.call('claimControl',{sessionId:id,runtimeEpoch:after.session.runtimeEpoch});await b.call('input',{sessionId:id,runtimeEpoch:third.runtimeEpoch,controlEpoch:third.controlEpoch,inputSeq:1,data:'after reconnect\r'});await until(()=>b.events.some(e=>e.event==='output'&&e.data.includes('ACK:after reconnect')));
  const history=await b.call('history',{sessionId:id});assert.ok(history.entries.some((e:any)=>e.data.includes('ACK:first marker')));
  const logout=await fetch(`http://127.0.0.1:${f.port}/auth/logout`,{method:'POST',headers:{origin:f.origin,cookie:b.cookie,'x-csrf-token':b.auth.csrfToken,'content-type':'application/json'},body:'{}'});assert.equal(logout.status,200);
  await until(async()=>{const state=await f.direct('list');return state.sessions[0].controller===null;});
  const state=await f.direct('list');assert.equal(state.sessions[0].processState,'running');
 }finally{a.close();b.close();other.close();await f.close();}
});
