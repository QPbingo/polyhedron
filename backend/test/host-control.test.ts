import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import {HostManager} from '../src/host/manager.js';
import type {HostConfig} from '../src/shared/types.js';

const dirs:string[]=[];test.after(()=>dirs.forEach(dir=>rmSync(dir,{recursive:true,force:true})));
function setup(){const dir=realpathSync(mkdtempSync(join(tmpdir(),'poly-control-'))),root=join(dir,'root');mkdirSync(root);dirs.push(dir);const config:HostConfig={hostId:'host-a',accountId:'account-a',hostToken:'host-secret-that-is-long-enough-1234',masterKey:'master-secret-that-never-leaves-host-1234',ipcToken:'ipc-secret-that-is-long-enough-1234',relayUrl:'ws://127.0.0.1/ws',name:'Host',roots:[root],dataDir:join(dir,'data')};const manager=new HostManager(config,{detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e',"process.stdin.on('data',d=>process.stdout.write('ACK:'+d));process.stdout.write('READY\\r\\n')"],env:{}})});return {root,config,manager}}
async function call(manager:HostManager,config:HostConfig,clientId:string,channelId:string,method:string,params:Record<string,unknown>={}){const operationId=typeof params.operationId==='string'?params.operationId:randomUUID(),body={...params,operationId};const grant=await new SignJWT({hostId:config.hostId,clientId,scope:'host',method,sessionId:body.sessionId}).setSubject(config.accountId).setIssuedAt().setExpirationTime('30s').setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(config.hostToken));return manager.rpc({type:'rpc',requestId:randomUUID(),clientId,channelId,method,params:body,grant})}
async function until(check:()=>boolean){const end=Date.now()+3000;while(!check()){if(Date.now()>end)throw new Error('timeout');await new Promise(resolve=>setTimeout(resolve,20))}}

test('an encrypted channel identifier is single-use for the Host process',async()=>{
  const {manager}=setup();
  try{
    await manager.openChannel('one-use-channel',Date.now()+30_000);await manager.closeChannel('client','one-use-channel');
    await assert.rejects(manager.openChannel('one-use-channel',Date.now()+30_000),(error:any)=>error.code==='CHANNEL_REPLAY');
  }finally{await manager.close()}
});

test('channel-bound control is single-writer and stale authenticated operations are journaled',async()=>{
  const {root,config,manager}=setup();
  try{
    const project=await call(manager,config,'a','a-1','addProject',{name:'P',path:root});const session=await call(manager,config,'a','a-1','createSession',{projectId:project.id,title:'S',agent:'codex'});
    await until(()=>manager.store.journal.eventsAfter(`session:${session.id}`,0).some(event=>event.kind==='pty_output'&&String((event.payload as any).data).includes('READY')));
    const firstAttach=await call(manager,config,'a','a-1','attach',{sessionId:session.id,lastAppliedOffset:0});assert.equal(firstAttach.session.controller,null);assert.match(firstAttach.data,/READY/);
    await call(manager,config,'b','b-1','attach',{sessionId:session.id,lastAppliedOffset:0});
    const first=await call(manager,config,'a','a-1','claimControl',{sessionId:session.id,runtimeOffset:session.runtimeOffset});
    const second=await call(manager,config,'b','b-1','claimControl',{sessionId:session.id,runtimeOffset:session.runtimeOffset});
    assert.ok(second.controlOffset>first.controlOffset);assert.equal(second.controller,'b-1');
    const staleId=randomUUID();await assert.rejects(call(manager,config,'a','a-1','input',{operationId:staleId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:first.controlOffset,data:'MUST_NOT_WRITE\r'}),(error:any)=>error.code==='STALE_CONTROL');
    const duplicate=manager.store.journal.begin({streamId:`session:${session.id}`,operationId:staleId,actor:'a-1',kind:'input',payload:{bytes:15,digest:manager.store.cipher.digest('MUST_NOT_WRITE\r'),runtimeOffset:session.runtimeOffset,controlOffset:first.controlOffset}}).duplicate;
    assert.equal(duplicate?.status,'failed');assert.equal(duplicate?.error?.code,'STALE_CONTROL');

    await call(manager,config,'a','a-2','attach',{sessionId:session.id,lastAppliedOffset:0});
    await assert.rejects(call(manager,config,'a','a-2','input',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:first.controlOffset,data:'OLD_CHANNEL\r'}),(error:any)=>error.code==='STALE_CONTROL');
    await call(manager,config,'b','b-1','detach',{sessionId:session.id});
    const state=await call(manager,config,'a','a-2','list');assert.equal(state.sessions[0].controller,null);assert.equal(state.sessions[0].controlOffset,null);
  }finally{await manager.close()}
});

test('atomic attach snapshot and tail cover every committed offset during output',async()=>{
  const {root,config,manager}=setup();const events:any[]=[];manager.on('event',event=>events.push(event));
  try{
    const project=await call(manager,config,'a','a-1','addProject',{name:'P',path:root});const session=await call(manager,config,'a','a-1','createSession',{projectId:project.id,title:'S',agent:'codex'});await call(manager,config,'a','a-1','attach',{sessionId:session.id,lastAppliedOffset:0});const owner=await call(manager,config,'a','a-1','claimControl',{sessionId:session.id,runtimeOffset:session.runtimeOffset});await call(manager,config,'a','a-1','input',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:owner.controlOffset,data:'marker\r'});await until(()=>events.some(event=>event.kind==='pty_output'&&event.data.includes('ACK:marker')));
    const attached=await call(manager,config,'b','b-1','attach',{sessionId:session.id,lastAppliedOffset:0});const offsets=attached.events.map((event:any)=>event.offset);
    assert.deepEqual(offsets,Array.from({length:attached.headOffset-attached.baseOffset},(_,index)=>attached.baseOffset+index+1));
    assert.ok(attached.baseOffset<=attached.headOffset);assert.match(attached.data,/ACK:marker/);
  }finally{await manager.close()}
});
