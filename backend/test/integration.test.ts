import test from 'node:test';
import assert from 'node:assert/strict';
import {createFixture,until} from './fixtures/setup.js';
import {createEncryptedClient} from './fixtures/secure-client.js';
test('real relay + connector + host preserve PTY across takeover, connector/relay restart and reject foreign account',async()=>{
 const f=await createFixture(),a=await createEncryptedClient(f),b=await createEncryptedClient(f),other=await createEncryptedClient(f,'another account');
 try{
  const folders=await a.call('listDirectories');assert.ok(folders.entries.length>0);await assert.rejects(other.call('listDirectories'),(e:any)=>e.code==='HOST_NOT_FOUND');
  const id=f.session.id;await a.call('attach',{sessionId:id,lastAppliedOffset:0});const owner=await a.call('claimControl',{sessionId:id,runtimeOffset:f.session.runtimeOffset});
  await a.call('resize',{sessionId:id,runtimeOffset:owner.runtimeOffset,controlOffset:owner.controlOffset,cols:92,rows:27});
  await a.call('input',{sessionId:id,runtimeOffset:owner.runtimeOffset,controlOffset:owner.controlOffset,data:'first marker\r'});
  await until(()=>a.events.some(e=>e.kind==='pty_output'&&e.data.includes('ACK:first marker')));
  await assert.rejects(other.call('attach',{sessionId:id}),(e:any)=>e.code==='HOST_NOT_FOUND');
  await b.call('attach',{sessionId:id,lastAppliedOffset:0});const next=await b.call('claimControl',{sessionId:id,runtimeOffset:f.session.runtimeOffset});
  await assert.rejects(a.call('input',{sessionId:id,runtimeOffset:owner.runtimeOffset,controlOffset:owner.controlOffset,data:'MUST NOT SEND\r'}),(e:any)=>e.code==='STALE_CONTROL');
  a.close();await f.restartConnector();const snapshot=await b.call('attach',{sessionId:id,lastAppliedOffset:0});assert.equal(snapshot.session.runtimeOffset,f.session.runtimeOffset);assert.match(snapshot.data,/ACK:first marker/);assert.equal(snapshot.session.processState,'running');
  await f.restartRelay();await b.reconnect();const after=await b.call('attach',{sessionId:id,lastAppliedOffset:0});assert.equal(after.session.runtimeOffset,f.session.runtimeOffset);assert.match(after.data,/ACK:first marker/);assert.doesNotMatch(after.data,/MUST NOT SEND/);
  const third=await b.call('claimControl',{sessionId:id,runtimeOffset:after.session.runtimeOffset});await b.call('input',{sessionId:id,runtimeOffset:third.runtimeOffset,controlOffset:third.controlOffset,data:'after reconnect\r'});await until(()=>b.events.some(e=>e.kind==='pty_output'&&e.data.includes('ACK:after reconnect')));
  const history=await b.call('history',{sessionId:id,runtimeOffset:after.session.runtimeOffset});assert.ok(history.entries.some((e:any)=>e.data.includes('ACK:first marker')));
  const logout=await fetch(`http://127.0.0.1:${f.port}/auth/logout`,{method:'POST',headers:{origin:f.origin,cookie:b.cookie,'x-csrf-token':b.auth.csrfToken,'content-type':'application/json'},body:'{}'});assert.equal(logout.status,200);
  await until(async()=>{const state=await f.direct('list');return state.sessions[0].controller===null;});
  const state=await f.direct('list');assert.equal(state.sessions[0].processState,'running');
 }finally{a.close();b.close();other.close();await f.close();}
});
