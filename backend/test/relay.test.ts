import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { jwtVerify } from 'jose';
import {encodeFrame,decodeFrame} from '../src/shared/wire.js';
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

test('websocket RPC is bound to account and tab, logout sends detach and closes browser',async()=>{
  const app=await createRelay(config);const sockets:WebSocket[]=[];
  try {
    const alice=await login(app,'alice'),bob=await login(app,'bob');
    await app.relayStore.upsertHost({id:'host-one',accountId:alice.user.id,name:'Mac',hostToken:'host-secret-abcdefghijklmnopqrstuvwxyz123456'});
    const address=await app.listen({host:'127.0.0.1',port:0});const wsUrl=address.replace('http','ws');
    const host=await open(`${wsUrl}/ws/host`,{headers:{authorization:'Bearer host-secret-abcdefghijklmnopqrstuvwxyz123456','x-host-id':'host-one'}});sockets.push(host);
    const clientId=randomUUID();const browser=await open(`${wsUrl}/ws/browser?clientId=${clientId}`,{headers:headers(alice)});sockets.push(browser);
    const foreign=await open(`${wsUrl}/ws/browser?clientId=${randomUUID()}`,{headers:headers(bob)});sockets.push(foreign);
    const denied=next(foreign,x=>x.type==='response');foreign.send(JSON.stringify({type:'request',id:'deny',hostId:'host-one',method:'list',params:{}}));assert.equal((await denied).error.code,'HOST_NOT_FOUND');
    const outbound=next(host,x=>x.type==='rpc');browser.send(JSON.stringify({type:'request',id:'mine',hostId:'host-one',method:'attach',clientId:'spoofed',params:{sessionId:'session-one'}}));
    const rpc=await outbound;assert.equal(rpc.clientId,clientId);
    const {payload}=await jwtVerify(rpc.grant,new TextEncoder().encode('host-secret-abcdefghijklmnopqrstuvwxyz123456'));
    assert.equal(payload.sub,alice.user.id);assert.equal(payload.hostId,'host-one');assert.equal(payload.clientId,clientId);assert.equal(payload.scope,'host');assert.ok(Number(payload.exp)-Date.now()/1000<=30);
    const response=next(browser,x=>x.id==='mine');host.send(JSON.stringify({type:'result',requestId:rpc.requestId,result:{seq:0}}));assert.equal((await response).result.seq,0);
    const detached=next(host,x=>x.type==='rpc'&&x.method==='detach');const closed=once(browser,'close');
    await app.inject({method:'POST',url:'/auth/logout',headers:headers(alice)});
    assert.equal((await detached).clientId,clientId);await closed;
    assert.equal((await app.inject({url:'/api/auth',headers:{cookie:alice.cookie}})).json().authenticated,false);
  } finally {for(const socket of sockets) socket.terminate();await app.close()}
});


test('only subscribed owner tab receives output, snapshot and resync; foreign targets are discarded',async()=>{
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
    const denied:any[]=[],seen:any[]=[];observer.on('message',data=>denied.push(decodeFrame(data)));foreign.on('message',data=>denied.push(decodeFrame(data)));
    const request=next(host);owner.send(JSON.stringify({type:'request',id:'attach',hostId:'output-host',method:'attach',params:{sessionId:'s1'}}));
    const rpc=await request,response=next(owner,x=>x.type==='response');host.send(JSON.stringify({type:'result',requestId:rpc.requestId,result:{seq:0}}));await response;
    owner.on('message',data=>seen.push(decodeFrame(data)));
    const event={type:'event',event:'output',hostId:'output-host',sessionId:'s1',clientId,runtimeEpoch:'run1',seq:1,data:'private terminal'};
    host.send(encodeFrame({...event,clientId:foreignId}));host.send(encodeFrame({...event,clientId:observerId}));host.send(encodeFrame({...event,sessionId:'unsubscribed'}));host.send(encodeFrame({...event,hostId:'other-host'}));host.send(encodeFrame({...event,clientId:undefined}));
    const output=next(owner,x=>x.event==='output');host.send(encodeFrame(event));assert.equal((await output).data,'private terminal');
    const snapshot=next(owner,x=>x.event==='snapshot');host.send(encodeFrame({...event,event:'snapshot',seq:2,data:'x'.repeat(3*1024*1024)}));assert.equal((await snapshot).data.length,3*1024*1024);
    const resync=next(owner,x=>x.event==='resync');host.send(encodeFrame({...event,event:'resync',message:'resync'}));assert.equal((await resync).message,'resync');
    assert.equal(denied.length,0);assert.deepEqual(seen.map(e=>e.event),['output','snapshot','resync']);
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
    const attachment=next(host);browser.send(JSON.stringify({type:'request',id:'attach',hostId:'h',method:'attach',params:{sessionId:'s'}}));const rpc=await attachment;const response=next(browser,x=>x.type==='response');host.send(JSON.stringify({type:'result',requestId:rpc.requestId,result:{seq:0}}));await response;
    const detach=next(host,x=>x.method==='detach');
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

test('authorization renews attached clients within ten seconds and persisted revocation detaches them',async()=>{
  const app=await createRelay(config);const sockets:WebSocket[]=[];
  try{
    const me=await login(app),hostToken='renewal-host-secret-abcdefghijklmnopqrstuvwxyz';
    await app.relayStore.upsertHost({id:'renew-host',accountId:me.user.id,name:'Mac',hostToken});
    const url=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');
    const host=await open(`${url}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'renew-host'}});sockets.push(host);
    const clientId=randomUUID(),browser=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(me)});sockets.push(browser);
    const attach=next(host);browser.send(JSON.stringify({type:'request',id:'attach',hostId:'renew-host',method:'attach',params:{sessionId:'s'}}));
    const rpc=await attach,response=next(browser,x=>x.id==='attach');host.send(JSON.stringify({type:'result',requestId:rpc.requestId,result:{seq:0}}));await response;
    const renewed=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Authorization was not renewed within its ten-second window')),11_000);host.on('message',data=>{const msg=decodeFrame(data);if(msg.method==='authorize'){clearTimeout(timer);resolve(msg);}})});
    const renewal=await renewed;const {payload}=await jwtVerify(renewal.grant,new TextEncoder().encode(hostToken));assert.equal(payload.clientId,clientId);assert.equal(payload.method,'authorize');
    host.send(JSON.stringify({type:'result',requestId:renewal.requestId,result:{ok:true}}));
    const token=me.cookie.split('=')[1],session=await app.relayStore.getSession(token);assert.ok(session);await app.relayStore.revokeSession(session.hash);
    const detach=next(host,x=>x.method==='detach'),closed=once(browser,'close');
    // The next RPC checks durable revocation immediately; the renewal timer also checks it.
    browser.send(JSON.stringify({type:'request',id:'after-revoke',hostId:'renew-host',method:'input',params:{sessionId:'s',data:'must never run'}}));
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
    const browser=await open(`${url}/ws/browser?clientId=${randomUUID()}`,{headers:headers(me)});sockets.push(browser);
    const forwarded:any[]=[],responses:any[]=[];host.on('message',data=>forwarded.push(decodeFrame(data)));browser.on('message',data=>responses.push(decodeFrame(data)));
    for(let i=0;i<80;i++)browser.send(JSON.stringify({type:'request',id:String(i),hostId:'bounded-host',method:'list',params:{}}));
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.ok(forwarded.length<=64,`${forwarded.length} requests forwarded while host stalled`);
    assert.ok(responses.filter(r=>r.error?.code==='BUSY').length>=16);
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
    for(const clientId of clients){const tab=await open(`${url}/ws/browser?clientId=${clientId}`,{headers:headers(target)});sockets.push(tab);tabs.push(tab);const sent=next(host,x=>x.method==='attach');tab.send(JSON.stringify({type:'request',id:'attach',hostId:'browser-host',method:'attach',params:{sessionId:'s'}}));const request=await sent;const received=next(tab,x=>x.id==='attach');host.send(JSON.stringify({type:'result',requestId:request.requestId,result:{seq:0}}));await received;}
    const requester=await open(`${url}/ws/browser?clientId=${randomUUID()}`,{headers:headers(admin)});sockets.push(requester);
    const detached=new Promise<string[]>((resolve,reject)=>{const ids:string[]=[];const timer=setTimeout(()=>reject(new Error('Both revoked tabs must detach')),3000);host.on('message',data=>{const message=decodeFrame(data);if(message.method==='detach'){ids.push(message.clientId);if(ids.length===2){clearTimeout(timer);resolve(ids);}}});});
    const closed=Promise.all(tabs.map(tab=>once(tab,'close')));
    const revoked=await app.inject({method:'POST',url:`/api/browsers/${targetId}/revoke`,headers:headers(admin)});assert.equal(revoked.statusCode,200,revoked.body);
    assert.deepEqual((await detached).sort(),clients.sort());await closed;assert.equal(requester.readyState,WebSocket.OPEN);
    assert.equal((await app.inject({url:'/api/auth',headers:headers(target)})).json().authenticated,false);
    assert.equal((await app.inject({url:'/api/auth',headers:headers(admin)})).json().authenticated,true);
    await assert.rejects(open(`${url}/ws/browser?clientId=${randomUUID()}`,{headers:headers(target)}),/401/);
    const sent=next(host,x=>x.method==='list');requester.send(JSON.stringify({type:'request',id:'still-authorized',hostId:'browser-host',method:'list',params:{}}));const request=await sent;const received=next(requester,x=>x.id==='still-authorized');host.send(JSON.stringify({type:'result',requestId:request.requestId,result:{ok:true}}));assert.equal((await received).result.ok,true);
  }finally{for(const socket of sockets)socket.terminate();await app.close();}
});
