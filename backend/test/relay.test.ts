import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { jwtVerify } from 'jose';
import {decodeFrame} from '../src/shared/wire.js';
import { createRelay } from '../src/relay/app.js';

const origin = 'http://127.0.0.1:5173';
const config = {devAuth:true,bindHost:'127.0.0.1',publicOrigin:origin,sessionSecret:'test-session-secret-at-least-32-characters',databasePath:':memory:'};
async function login(app:any,name='本地用户') {
  const r = await app.inject({method:'POST',url:'/auth/dev',headers:{origin},payload:{name}});
  assert.equal(r.statusCode,200,r.body);
  return {cookie:r.headers['set-cookie'].split(';')[0],csrf:r.json().csrfToken,user:r.json().user};
}
function headers(login:any) { return {cookie:login.cookie,origin,'x-csrf-token':login.csrf}; }
async function open(url:string,options:any={}) { const ws=new WebSocket(url,options); await once(ws,'open'); return ws; }
function next(ws:WebSocket,predicate:(x:any)=>boolean=()=>true):Promise<any> {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('message timeout'))},3000); const onMessage=(data:any)=>{const x=decodeFrame(data);if(predicate(x)){cleanup();resolve(x)}}; const cleanup=()=>{clearTimeout(timer);ws.off('message',onMessage)};ws.on('message',onMessage)});
}
async function establish(host:WebSocket,browser:WebSocket,hostId:string,clientId:string,channelId=randomUUID()){
  const opening=next(host,message=>message.type==='channel_open'),received=next(browser,message=>message.type==='channel_opened');browser.send(JSON.stringify({type:'open_channel',id:`open-${channelId}`,hostId,channelId,clientPublicKey:'A'.repeat(87)}));const request=await opening;host.send(JSON.stringify({type:'channel_opened',requestId:request.requestId,clientId,channelId,hello:{v:1}}));await received;return {channelId,request};
}

test('development authentication is explicit and loopback only',async()=>{
  await assert.rejects(createRelay({...config,bindHost:'0.0.0.0'}),/loopback/i);
  await assert.rejects(createRelay({...config,devAuth:false}),/OIDC|oidc/);
  const app=await createRelay(config);
  try {
    const remote=await app.inject({method:'POST',url:'/auth/dev',remoteAddress:'192.168.1.8',headers:{origin},payload:{}});
    assert.equal(remote.statusCode,403);
    const badOrigin=await app.inject({method:'POST',url:'/auth/dev',headers:{origin:'http://evil.test'},payload:{}});
    assert.equal(badOrigin.statusCode,403);
  } finally {await app.close()}
});

test('session cookie is HttpOnly and logout requires CSRF, revokes persisted session',async()=>{
  const app=await createRelay(config);
  try {
    const first=await app.inject({method:'GET',url:'/api/auth'});assert.equal(first.json().authenticated,false);
    const me=await login(app);
    assert.equal((await app.inject({url:'/api/auth',headers:{cookie:me.cookie}})).json().user.id,me.user.id);
    assert.equal((await app.inject({method:'POST',url:'/auth/logout',headers:{cookie:me.cookie,origin}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/auth/logout',headers:headers(me)})).statusCode,200);
    assert.equal((await app.inject({url:'/api/auth',headers:{cookie:me.cookie}})).json().authenticated,false);
    assert.equal((await app.inject({url:'/api/hosts',headers:{cookie:me.cookie}})).statusCode,401);
  } finally {await app.close()}
});

test('pairing secrets are issued once, ownership is isolated, foreign revoke is denied',async()=>{
  const app=await createRelay(config);
  try {
    const alice=await login(app,'alice'), bob=await login(app,'bob');
    const start=await app.inject({method:'POST',url:'/api/pairings/start',payload:{name:'Mac'}});
    assert.equal(start.statusCode,200);const pairing=start.json();
    assert.equal((await app.inject({method:'POST',url:'/api/pairings/poll',payload:{pairingId:pairing.pairingId,pollToken:'wrong'}})).statusCode,401);
    const poll={pairingId:pairing.pairingId,pollToken:pairing.pollToken};
    assert.deepEqual((await app.inject({method:'POST',url:'/api/pairings/poll',payload:poll})).json(),{status:'pending'});
    assert.equal((await app.inject({method:'POST',url:'/api/pairings/approve',headers:headers(alice),payload:{code:pairing.code}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/pairings/approve',headers:headers(bob),payload:{code:pairing.code}})).statusCode,409);
    const paired=(await app.inject({method:'POST',url:'/api/pairings/poll',payload:poll})).json();
    assert.equal(paired.accountId,alice.user.id);assert.ok(paired.hostToken.length>=32);
    assert.equal((await app.inject({method:'POST',url:'/api/pairings/poll',payload:poll})).statusCode,410);
    assert.equal((await app.inject({url:'/api/hosts',headers:headers(bob)})).json().hosts.length,0);
    assert.equal((await app.inject({url:'/api/hosts',headers:headers(alice)})).json().hosts[0].id,paired.hostId);
    assert.equal((await app.inject({method:'POST',url:`/api/hosts/${paired.hostId}/revoke`,headers:headers(bob)})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:`/api/hosts/${paired.hostId}/revoke`,headers:headers(alice)})).statusCode,200);
    assert.equal((await app.inject({url:'/api/hosts',headers:headers(alice)})).json().hosts.length,0);
  } finally {await app.close()}
});

test('expired pairing cannot be approved',async()=>{
  const app=await createRelay({...config,pairingTtlMs:10});
  try {const me=await login(app);const p=(await app.inject({method:'POST',url:'/api/pairings/start',payload:{name:'Mac'}})).json();await new Promise(r=>setTimeout(r,20));assert.equal((await app.inject({method:'POST',url:'/api/pairings/approve',headers:headers(me),payload:{code:p.code}})).statusCode,410)}finally{await app.close()}
});

test('encrypted channel grant is bound to account and tab; logout closes the channel',async()=>{
  const app=await createRelay(config);const sockets:WebSocket[]=[];
  try {
    const alice=await login(app,'alice'),bob=await login(app,'bob');
    await app.relayStore.upsertHost({id:'host-one',accountId:alice.user.id,name:'Mac',hostToken:'host-secret-abcdefghijklmnopqrstuvwxyz123456'});
    const address=await app.listen({host:'127.0.0.1',port:0});const wsUrl=address.replace('http','ws');
    const host=await open(`${wsUrl}/ws/host`,{headers:{authorization:'Bearer host-secret-abcdefghijklmnopqrstuvwxyz123456','x-host-id':'host-one'}});sockets.push(host);
    const clientId=randomUUID();const browser=await open(`${wsUrl}/ws/browser?clientId=${clientId}`,{headers:headers(alice)});sockets.push(browser);
    const foreign=await open(`${wsUrl}/ws/browser?clientId=${randomUUID()}`,{headers:headers(bob)});sockets.push(foreign);
    const denied=next(foreign,x=>x.type==='response');foreign.send(JSON.stringify({type:'open_channel',id:'deny',hostId:'host-one',channelId:randomUUID(),clientPublicKey:'A'.repeat(87)}));assert.equal((await denied).error.code,'HOST_NOT_FOUND');
    const opened=await establish(host,browser,'host-one',clientId);assert.equal(opened.request.clientId,clientId);const {payload}=await jwtVerify(opened.request.grant,new TextEncoder().encode('host-secret-abcdefghijklmnopqrstuvwxyz123456'));
    assert.equal(payload.sub,alice.user.id);assert.equal(payload.aud,'polyhedron-host:host-one');assert.equal(payload.hostId,'host-one');assert.equal(payload.clientId,clientId);assert.equal(payload.clientInstanceId,clientId);assert.match(String(payload.deviceId),/^[0-9a-f]{64}$/);assert.equal(payload.scope,'channel');assert.equal(payload.channelId,opened.channelId);assert.ok(Number(payload.exp)-Date.now()/1000<=30);
    const detached=next(host,x=>x.type==='channel_close'&&x.channelId===opened.channelId),closed=once(browser,'close');
    await app.inject({method:'POST',url:'/auth/logout',headers:headers(alice)});
    assert.equal((await detached).clientId,clientId);await closed;
    assert.equal((await app.inject({url:'/api/auth',headers:{cookie:alice.cookie}})).json().authenticated,false);
  } finally {for(const socket of sockets) socket.terminate();await app.close()}
});


test('only the channel owner receives opaque Host events; foreign targets are discarded',async()=>{
  const app=await createRelay(config);const sockets:WebSocket[]=[];
  try {
    const alice=await login(app,'alice'),bob=await login(app,'bob');
    const hostToken='secret-token-123456789012345678901234';
    await app.relayStore.upsertHost({id:'output-host',accountId:alice.user.id,name:'Mac',hostToken});
    const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');
    const host=await open(`${url}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'output-host'}});sockets.push(host);
    const clientId=randomUUID(),foreignId=randomUUID(),observerId=randomUUID();
    const owner=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(alice)});sockets.push(owner);
    const observer=await open(`${url}/ws/browser?clientId=${observerId}`,{headers:headers(alice)});sockets.push(observer);
    const foreign=await open(`${url}/ws/browser?clientId=${foreignId}`,{headers:headers(bob)});sockets.push(foreign);
    const opened=await establish(host,owner,'output-host',clientId),denied:any[]=[];observer.on('message',data=>denied.push(decodeFrame(data)));foreign.on('message',data=>denied.push(decodeFrame(data)));
    for(const invalid of [{clientId:foreignId,channelId:opened.channelId},{clientId:observerId,channelId:opened.channelId},{clientId,channelId:randomUUID()}])host.send(JSON.stringify({type:'sealed_event',...invalid,cipher:{v:1,nonce:1,ciphertext:'WRONG_TARGET'}}));
    const output=next(owner,x=>x.type==='sealed_event');host.send(JSON.stringify({type:'sealed_event',clientId,channelId:opened.channelId,cipher:{v:1,nonce:1,ciphertext:'OPAQUE_TERMINAL'}}));assert.equal((await output).cipher.ciphertext,'OPAQUE_TERMINAL');
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(denied.length,0);
  }finally{for(const ws of sockets)ws.terminate();await app.close();}
});

test('revoked host token cannot reconnect and connected host is closed',async()=>{
  const app=await createRelay(config);let host:WebSocket|undefined,browser:WebSocket|undefined;
  try {
    const me=await login(app);const token='revoke-token-1234567890123456789012345';
    await app.relayStore.upsertHost({id:'h',accountId:me.user.id,name:'Mac',hostToken:token});
    const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');
    host=await open(`${url}/ws/host`,{headers:{authorization:`Bearer ${token}`,'x-host-id':'h'}});
    const clientId=randomUUID();browser=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(me)});
    const opened=await establish(host,browser,'h',clientId),detach=next(host,x=>x.type==='channel_close'&&x.channelId===opened.channelId);
    const closed=once(host,'close');assert.equal((await app.inject({method:'POST',url:'/api/hosts/h/revoke',headers:headers(me)})).statusCode,200);assert.equal((await detach).clientId,clientId);await closed;
    await assert.rejects(open(`${url}/ws/host`,{headers:{authorization:`Bearer ${token}`,'x-host-id':'h'}}),/401/);
  }finally{host?.terminate();browser?.terminate();await app.close();}
});

test('browser websocket rejects missing cookie, foreign Origin and reuse of another login tab identity',async()=>{
  const app=await createRelay(config);let owner:WebSocket|undefined;
  try{
    const me=await login(app,'alice'),foreign=await login(app,'bob');const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');const id=randomUUID();
    await assert.rejects(open(`${url}/ws/browser?clientId=${id}`,{headers:{origin}}),/401/);
    await assert.rejects(open(`${url}/ws/browser?clientId=${id}`,{headers:{...headers(me),origin:'https://evil.example'}}),/403/);
    owner=await open(`${url}/ws/browser?clientId=${id}`,{headers:headers(me)});
    await assert.rejects(open(`${url}/ws/browser?clientId=${id}`,{headers:headers(foreign)}),/409/);
  }finally{owner?.terminate();await app.close();}
});

test('channel authorization renews within ten seconds and persisted revocation closes it',async()=>{
  const app=await createRelay(config);const sockets:WebSocket[]=[];
  try{
    const me=await login(app),hostToken='renewal-host-secret-abcdefghijklmnopqrstuvwxyz';
    await app.relayStore.upsertHost({id:'renew-host',accountId:me.user.id,name:'Mac',hostToken});
    const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');
    const host=await open(`${url}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'renew-host'}});sockets.push(host);
    const clientId=randomUUID(),browser=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(me)});sockets.push(browser);
    const opened=await establish(host,browser,'renew-host',clientId);
    const renewed=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Authorization was not renewed within its ten-second window')),11_000);host.on('message',data=>{const msg=decodeFrame(data);if(msg.type==='channel_renew'){clearTimeout(timer);resolve(msg);}})});
    const renewal=await renewed;const {payload}=await jwtVerify(renewal.grant,new TextEncoder().encode(hostToken));assert.equal(payload.clientId,clientId);assert.equal(payload.channelId,opened.channelId);
    const token=me.cookie.split('=')[1],session=await app.relayStore.getSession(token);assert.ok(session);await app.relayStore.revokeSession(session.hash);
    const detach=next(host,x=>x.type==='channel_close'&&x.channelId===opened.channelId),closed=once(browser,'close');
    // The next RPC checks durable revocation immediately; the renewal timer also checks it.
    browser.send(JSON.stringify({type:'sealed',id:'after-revoke',hostId:'renew-host',channelId:opened.channelId,cipher:{v:1,nonce:1,ciphertext:'must-never-run'}}));
    assert.equal((await detach).clientId,clientId);await closed;
  }finally{for(const ws of sockets)ws.terminate();await app.close();}
});

test('a browser cannot queue more than 64 host requests while the host is stalled',async()=>{
  const app=await createRelay({...config,rpcTimeoutMs:1000});const sockets:WebSocket[]=[];
  try{
    const me=await login(app),hostToken='bounded-host-secret-abcdefghijklmnopqrstuvwxyz';
    await app.relayStore.upsertHost({id:'bounded-host',accountId:me.user.id,name:'Mac',hostToken});
    const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');
    const host=await open(`${url}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'bounded-host'}});sockets.push(host);
    const clientId=randomUUID(),browser=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(me)});sockets.push(browser);const opened=await establish(host,browser,'bounded-host',clientId);
    const forwarded:any[]=[],responses:any[]=[];host.on('message',data=>forwarded.push(decodeFrame(data)));browser.on('message',data=>responses.push(decodeFrame(data)));
    for(let i=0;i<80;i++)browser.send(JSON.stringify({type:'sealed',id:String(i),hostId:'bounded-host',channelId:opened.channelId,cipher:{v:1,nonce:i+1,ciphertext:'OPAQUE'}}));
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.ok(forwarded.length<=64,`${forwarded.length} requests forwarded while host stalled`);
    assert.ok(responses.filter(r=>r.error?.code==='BUSY').length>=16);
  }finally{for(const ws of sockets)ws.terminate();await app.close();}
});

test('a browser is limited to 16 active or opening encrypted channels',async()=>{
  const app=await createRelay({...config,rpcTimeoutMs:1000});const sockets:WebSocket[]=[];
  try{
    const me=await login(app),hostToken='channel-limit-host-secret-abcdefghijklmnopqrstuvwxyz';
    await app.relayStore.upsertHost({id:'channel-limit-host',accountId:me.user.id,name:'Mac',hostToken});
    const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws'),host=await open(`${url}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'channel-limit-host'}});sockets.push(host);
    const clientId=randomUUID(),browser=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(me)});sockets.push(browser);
    const denied=next(browser,message=>message.type==='response'&&message.error?.code==='CHANNEL_LIMIT');for(let index=0;index<17;index++)browser.send(JSON.stringify({type:'open_channel',id:`channel-${index}`,hostId:'channel-limit-host',channelId:randomUUID(),clientPublicKey:'A'.repeat(87)}));assert.equal((await denied).error.code,'CHANNEL_LIMIT');
  }finally{for(const ws of sockets)ws.terminate();await app.close();}
});

test('browser login management lists only owned live sessions and protects current/foreign revocation',async()=>{
  const app=await createRelay(config);
  try{
    const first=await login(app,'alice'),second=await login(app,'alice'),foreign=await login(app,'bob');
    await app.relayStore.createSession(first.user.id,-1);
    assert.equal((await app.inject({url:'/api/browsers'})).statusCode,401);
    const listed=await app.inject({url:'/api/browsers',headers:headers(first)});assert.equal(listed.statusCode,200,listed.body);
    const entries=listed.json().browsers;assert.equal(entries.length,2);assert.equal(entries.filter((x:any)=>x.current).length,1);
    for(const entry of entries){assert.deepEqual(Object.keys(entry).sort(),['createdAt','current','expiresAt','id']);assert.match(entry.id,/^[0-9a-f]{64}$/);assert.ok(entry.createdAt<=Date.now());assert.ok(entry.expiresAt>Date.now());}
    const current=entries.find((x:any)=>x.current),other=entries.find((x:any)=>!x.current);
    assert.equal((await app.inject({url:'/api/auth',headers:{cookie:`polyhedron_session=${current.id}`}})).json().authenticated,false);
    const foreignEntry=(await app.inject({url:'/api/browsers',headers:headers(foreign)})).json().browsers[0];
    assert.equal((await app.inject({method:'POST',url:`/api/browsers/${foreignEntry.id}/revoke`,headers:headers(first)})).statusCode,404);
    assert.equal((await app.inject({url:'/api/auth',headers:headers(foreign)})).json().authenticated,true);
    assert.equal((await app.inject({method:'POST',url:`/api/browsers/${other.id}/revoke`,headers:{cookie:first.cookie,origin}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:`/api/browsers/${other.id}/revoke`,headers:{...headers(first),origin:'https://evil.example'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:`/api/browsers/${other.id}/revoke`,headers:headers(first)})).statusCode,200);
    assert.equal((await app.inject({url:'/api/auth',headers:headers(second)})).json().authenticated,false);
    assert.equal((await app.inject({url:'/api/browsers',headers:headers(first)})).json().browsers.length,1);
    const self=await app.inject({method:'POST',url:`/api/browsers/${current.id}/revoke`,headers:headers(first)});assert.equal(self.statusCode,200);assert.match(String(self.headers['set-cookie']),/Expires=Thu, 01 Jan 1970/);
    assert.equal((await app.inject({url:'/api/auth',headers:headers(first)})).json().authenticated,false);
  }finally{await app.close();}
});

test('revoking another browser login detaches every tab and preserves the requesting browser',async()=>{
  const app=await createRelay(config);const sockets:WebSocket[]=[];
  try{
    const admin=await login(app,'alice'),target=await login(app,'alice'),hostToken='browser-revoke-host-secret-abcdefghijklmnopqrstuvwxyz';
    await app.relayStore.upsertHost({id:'browser-host',accountId:admin.user.id,name:'Mac',hostToken});
    const listed=await app.inject({url:'/api/browsers',headers:headers(admin)});assert.equal(listed.statusCode,200,listed.body);
    const targetId=listed.json().browsers.find((x:any)=>!x.current).id;
    const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');
    const host=await open(`${url}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'browser-host'}});sockets.push(host);
    const clients=[randomUUID(),randomUUID()];
    const tabs:WebSocket[]=[];
    const channelIds:string[]=[];for(const clientId of clients){const tab=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(target)});sockets.push(tab);tabs.push(tab);channelIds.push((await establish(host,tab,'browser-host',clientId)).channelId)}
    const requester=await open(`${url}/ws/browser?clientId=${randomUUID()}`,{headers:headers(admin)});sockets.push(requester);
    const detached=new Promise<string[]>((resolve,reject)=>{const ids:string[]=[];const timer=setTimeout(()=>reject(new Error('Both revoked tabs must close channels')),3000);host.on('message',data=>{const message=decodeFrame(data);if(message.type==='channel_close'){ids.push(message.clientId);if(ids.length===2){clearTimeout(timer);resolve(ids);}}});});
    const closed=Promise.all(tabs.map(tab=>once(tab,'close')));
    const revoked=await app.inject({method:'POST',url:`/api/browsers/${targetId}/revoke`,headers:headers(admin)});assert.equal(revoked.statusCode,200,revoked.body);
    assert.deepEqual((await detached).sort(),clients.sort());await closed;assert.equal(requester.readyState,WebSocket.OPEN);
    assert.equal((await app.inject({url:'/api/auth',headers:headers(target)})).json().authenticated,false);
    assert.equal((await app.inject({url:'/api/auth',headers:headers(admin)})).json().authenticated,true);
    await assert.rejects(open(`${url}/ws/browser?clientId=${randomUUID()}`,{headers:headers(target)}),/401/);
    await establish(host,requester,'browser-host',(new URL(requester.url)).searchParams.get('clientId')!);
  }finally{for(const socket of sockets)socket.terminate();await app.close();}
});

test('opaque relay routes only encrypted channel envelopes and never accepts plaintext RPC content',async()=>{
  const app=await createRelay(config);const sockets:WebSocket[]=[];
  try{
    const me=await login(app),hostToken='opaque-host-secret-abcdefghijklmnopqrstuvwxyz';
    await app.relayStore.upsertHost({id:'opaque-host',accountId:me.user.id,name:'Mac',hostToken});
    const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws'),host=await open(`${url}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'opaque-host'}});sockets.push(host);
    const clientId=randomUUID(),browser=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(me)});sockets.push(browser);const channelId=randomUUID();
    const opening=next(host,x=>x.type==='channel_open');browser.send(JSON.stringify({type:'open_channel',id:'open-1',hostId:'opaque-host',channelId,clientPublicKey:'A'.repeat(87)}));const opened=await opening;
    assert.equal(opened.clientId,clientId);assert.equal(opened.channelId,channelId);const {payload}=await jwtVerify(opened.grant,new TextEncoder().encode(hostToken));assert.equal(payload.purpose,'channel');assert.equal(payload.channelId,channelId);assert.equal(payload.clientId,clientId);
    const browserOpened=next(browser,x=>x.type==='channel_opened');host.send(JSON.stringify({type:'channel_opened',requestId:opened.requestId,clientId,channelId,hello:{v:1}}));assert.equal((await browserOpened).id,'open-1');
    const cipher={v:1,nonce:1,ciphertext:'ENCRYPTED_BASE64URL_ONLY'};const forwarded=next(host,x=>x.type==='sealed');browser.send(JSON.stringify({type:'sealed',id:'sealed-1',hostId:'opaque-host',channelId,cipher}));const sealed=await forwarded;assert.deepEqual(sealed.cipher,cipher);assert.equal(sealed.method,undefined);assert.equal(sealed.params,undefined);
    const response=next(browser,x=>x.type==='sealed_result');host.send(JSON.stringify({type:'sealed_result',requestId:sealed.requestId,clientId,channelId,cipher:{v:1,nonce:1,ciphertext:'HOST_CIPHERTEXT'}}));assert.equal((await response).cipher.ciphertext,'HOST_CIPHERTEXT');
    const before=[] as any[];host.on('message',data=>before.push(decodeFrame(data)));const denied=next(browser,x=>x.type==='response'&&x.id==='plaintext');browser.send(JSON.stringify({type:'request',id:'plaintext',hostId:'opaque-host',method:'input',params:{data:'SENTINEL_PROMPT'}}));assert.equal((await denied).error.code,'INVALID_REQUEST');await new Promise(resolve=>setTimeout(resolve,30));assert.equal(before.some(message=>JSON.stringify(message).includes('SENTINEL_PROMPT')),false);
  }finally{for(const socket of sockets)socket.terminate();await app.close();}
});
