import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {createECDH,randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {SignJWT} from 'jose';
import {createHostServer} from '../src/host/server.js';
import {decodeFrame} from '../src/shared/wire.js';
import type {HostConfig} from '../src/shared/types.js';

test('Host reserves opening slots before grant verification and never exceeds 256 channels',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'poly-host-cap-')),socketPath=join(dir,'host.sock'),config:HostConfig={hostId:'host-cap',accountId:'account-cap',hostToken:'host-channel-cap-secret-with-thirty-two-characters',masterKey:randomBytes(32).toString('base64url'),ipcToken:'ipc-channel-cap-secret-with-thirty-two-characters',relayUrl:'ws://127.0.0.1/ws/host',name:'Host cap',roots:[dir],dataDir:dir};let release!:()=>void;let blocked=false;const gate=new Promise<void>(resolve=>{release=resolve});
 class Manager extends EventEmitter{store={dir};opened=new Set<string>();max=0;async openChannel(id:string){if(blocked)await gate;this.opened.add(id);this.max=Math.max(this.max,this.opened.size)}async closeChannel(_client:string,id:string){this.opened.delete(id)}async renewChannel(){}async close(){}async hook(){return {ok:true}}}
 const manager=new Manager(),{app}=await createHostServer(config,manager as any);let socket:WebSocket|undefined;
 try{
  await app.listen({path:socketPath});socket=new WebSocket(`ws+unix://${socketPath}:/ipc`,{headers:{authorization:`Bearer ${config.ipcToken}`}});await once(socket,'open');const clientId=randomUUID(),ecdh=createECDH('prime256v1');ecdh.generateKeys();const clientPublicKey=ecdh.getPublicKey().toString('base64url'),messages:any[]=[];socket.on('message',data=>messages.push(decodeFrame(data)));
  async function sendOpen(index:number){const channelId=randomUUID(),requestId=`request-${index}`,grant=await new SignJWT({hostId:config.hostId,clientId,clientInstanceId:clientId,deviceId:'a'.repeat(64),channelId,scope:'channel',purpose:'channel',clientPublicKey}).setSubject(config.accountId).setAudience(`polyhedron-host:${config.hostId}`).setProtectedHeader({alg:'HS256'}).setExpirationTime('30s').sign(new TextEncoder().encode(config.hostToken));socket!.send(JSON.stringify({type:'channel_open',requestId,clientId,channelId,grant,hello:{v:1,hostId:config.hostId,channelId,clientPublicKey}}));return requestId}
  async function waitFor(requestId:string,type:string){const end=Date.now()+5000;while(!messages.some(message=>message.requestId===requestId&&message.type===type)){if(Date.now()>end)throw new Error(`Timed out waiting for ${type}`);await new Promise(resolve=>setTimeout(resolve,5))}return messages.find(message=>message.requestId===requestId&&message.type===type)}
  for(let index=0;index<240;index++){const requestId=await sendOpen(index);await waitFor(requestId,'channel_opened')}assert.equal(manager.opened.size,240);blocked=true;const burst=await Promise.all(Array.from({length:17},(_,index)=>sendOpen(240+index)));const end=Date.now()+5000;while(!messages.some(message=>message.type==='channel_error'&&burst.includes(message.requestId))){if(Date.now()>end)throw new Error('Timed out waiting for channel capacity rejection');await new Promise(resolve=>setTimeout(resolve,5))}const denied=messages.find(message=>message.type==='channel_error'&&burst.includes(message.requestId));assert.equal(denied.error.code,'CHANNEL_LIMIT');release();await Promise.all(burst.filter(id=>id!==denied.requestId).map(id=>waitFor(id,'channel_opened')));assert.equal(manager.max,256);assert.equal(manager.opened.size,256);
 }finally{release();socket?.terminate();await app.close();rmSync(dir,{recursive:true,force:true})}
});
