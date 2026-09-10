import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import {HostManager} from '../src/host/manager.js';
import {HostStore} from '../src/host/store.js';
import type {HostConfig,Session} from '../src/shared/types.js';

function fixture(name:string){
  const dir=mkdtempSync(join(tmpdir(),`poly-fault-${name}-`));
  const config:HostConfig={hostId:`host-${name}`,accountId:'account',hostToken:'fault-integration-host-token-0123456789',masterKey:'fault-integration-master-key-0123456789',ipcToken:'fault-integration-ipc-token-0123456789',relayUrl:'ws://127.0.0.1:1/ws/host',name:'Fault Host',roots:[dir],dataDir:join(dir,'data')};
  return {dir,config};
}

function persistedSession(config:HostConfig,state:Session['processState']='exited'){
  const store=new HostStore({dir:config.dataDir!,secret:config.masterKey,hostId:config.hostId});
  const started=store.journal.appendFact({streamId:'session:s1',kind:'runtime_started',payload:{}});
  const output=store.journal.appendFact({streamId:'session:s1',kind:'pty_output',runtimeOffset:started.offset,payload:{data:'RECOVERED_FROM_DURABLE_OUTPUT\r\n'}});
  const session:Session={id:'s1',hostId:config.hostId,projectId:'p1',title:'Recovery',agent:'codex',processState:state,activity:'idle',nativeSessionId:null,controller:state==='running'?'dead-channel':null,cols:80,rows:24,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false,runtimeOffset:started.offset,controlOffset:state==='running'?output.offset:null,headOffset:output.offset,journalState:'ready'};
  store.saveProject({id:'p1',hostId:config.hostId,name:'Recovery',path:config.roots[0],createdAt:session.createdAt});store.saveSession(session);
  return {store,session};
}

async function call(manager:HostManager,config:HostConfig,method:string,params:Record<string,unknown>={}){
  const clientId='fault-client',body={operationId:randomUUID(),...params};
  const grant=await new SignJWT({hostId:config.hostId,clientId,scope:'host',method,sessionId:body.sessionId}).setSubject(config.accountId).setProtectedHeader({alg:'HS256'}).setExpirationTime('30s').sign(new TextEncoder().encode(config.hostToken));
  return manager.rpc({type:'rpc',requestId:randomUUID(),clientId,channelId:'fault-channel',grant,method,params:body});
}

test('corrupt terminal snapshot falls back to the encrypted journal without losing output',async()=>{
  const {dir,config}=fixture('snapshot');const {store,session}=persistedSession(config);
  store.saveOffsetSnapshot({session,baseOffset:session.headOffset,headOffset:session.headOffset,data:'OLD_SNAPSHOT',cols:80,rows:24});
  store.db.prepare("UPDATE snapshots SET data='enc:v1:corrupt-ciphertext'").run();store.close();
  const manager=new HostManager(config,{detect:async()=>[]});
  try{
    const snapshot=await call(manager,config,'attach',{sessionId:session.id,lastAppliedOffset:0});
    assert.match(snapshot.data,/RECOVERED_FROM_DURABLE_OUTPUT/);assert.deepEqual(snapshot.events.map((event:any)=>event.offset),Array.from({length:snapshot.headOffset-snapshot.baseOffset},(_,index)=>snapshot.baseOffset+index+1));assert.equal(snapshot.events.at(-1).offset,snapshot.headOffset);assert.equal(snapshot.session.journalState,'ready');
  }finally{await manager.close();rmSync(dir,{recursive:true,force:true});}
});

test('a Host restart records interruption and clears stale channel ownership',async()=>{
  const {dir,config}=fixture('restart');const {store,session}=persistedSession(config,'running');const priorHead=session.headOffset;store.close();
  const manager=new HostManager(config,{detect:async()=>[]});
  try{
    const state=await call(manager,config,'list'),recovered=state.sessions[0];
    assert.equal(recovered.processState,'interrupted');assert.equal(recovered.controller,null);assert.equal(recovered.controlOffset,null);assert.equal(recovered.runtimeOffset,session.runtimeOffset);assert.equal(recovered.headOffset,priorHead+1);
    assert.equal(manager.store.journal.eventsAfter('session:s1',priorHead)[0].kind,'runtime_interrupted');
  }finally{await manager.close();rmSync(dir,{recursive:true,force:true});}
});

test('a corrupt snapshot for a normal empty runtime is discarded and rebuilt from its boundary',async()=>{
  const {dir,config}=fixture('historical-snapshot'),store=new HostStore({dir:config.dataDir!,secret:config.masterKey,hostId:config.hostId}),createdAt=new Date().toISOString(),old=store.journal.appendFact({streamId:'session:s1',kind:'runtime_started',payload:{cols:80,rows:24}}),current=store.journal.appendFact({streamId:'session:s1',kind:'runtime_started',payload:{cols:80,rows:24}}),session:Session={id:'s1',hostId:config.hostId,projectId:'p1',title:'Historical snapshot',agent:'codex',processState:'exited',activity:'idle',nativeSessionId:null,controller:null,cols:80,rows:24,createdAt,updatedAt:createdAt,archived:false,runtimeOffset:current.offset,controlOffset:null,headOffset:current.offset,journalState:'ready'};
  store.saveProject({id:'p1',hostId:config.hostId,name:'History',path:config.roots[0],createdAt});store.saveSession(session);store.saveOffsetSnapshot({session:{...session,runtimeOffset:old.offset},baseOffset:old.offset,headOffset:current.offset,data:'\x1b[',cols:80,rows:24});store.close();const manager=new HostManager(config,{detect:async()=>[]});
  try{const state=await call(manager,config,'list');assert.equal(state.sessions[0].journalState,'ready');const snapshot=await call(manager,config,'attach',{sessionId:'s1',lastAppliedOffset:0});assert.equal(snapshot.cols,80);assert.equal(snapshot.rows,24);assert.equal(snapshot.data,'')}finally{await manager.close();rmSync(dir,{recursive:true,force:true})}
});

test('a corrupt legacy snapshot-only runtime fails closed because no authoritative output exists',async()=>{
  const {dir,config}=fixture('legacy-snapshot'),store=new HostStore({dir:config.dataDir!,secret:config.masterKey,hostId:config.hostId}),createdAt=new Date().toISOString(),started=store.journal.appendFact({streamId:'session:s1',kind:'legacy_runtime_started',payload:{source:'legacy-v1',cols:80,rows:24}}),session:Session={id:'s1',hostId:config.hostId,projectId:'p1',title:'Legacy snapshot',agent:'codex',processState:'exited',activity:'idle',nativeSessionId:null,controller:null,cols:80,rows:24,createdAt,updatedAt:createdAt,archived:false,runtimeOffset:started.offset,controlOffset:null,headOffset:started.offset,journalState:'ready'};
  store.saveProject({id:'p1',hostId:config.hostId,name:'History',path:config.roots[0],createdAt});store.saveSession(session);store.saveOffsetSnapshot({session,baseOffset:started.offset,headOffset:started.offset,data:'\x1b[',cols:80,rows:24});store.close();const manager=new HostManager(config,{detect:async()=>[]});
  try{const state=await call(manager,config,'list');assert.equal(state.sessions[0].journalState,'integrity_failed');assert.match(state.sessions[0].warning,/旧版|快照/)}finally{await manager.close();rmSync(dir,{recursive:true,force:true})}
});

test('startup paginates and verifies retained runtimes older than the first 200',async()=>{
  const {dir,config}=fixture('many-runs'),store=new HostStore({dir:config.dataDir!,secret:config.masterKey,hostId:config.hostId}),createdAt=new Date().toISOString();let first=0,current=0;for(let index=0;index<201;index++){const event=store.journal.appendFact({streamId:'session:s1',kind:index===0?'legacy_runtime_started':'runtime_started',payload:{cols:80,rows:24}});if(!index)first=event.offset;current=event.offset}const session:Session={id:'s1',hostId:config.hostId,projectId:'p1',title:'Many runs',agent:'codex',processState:'exited',activity:'idle',nativeSessionId:null,controller:null,cols:80,rows:24,createdAt,updatedAt:createdAt,archived:false,runtimeOffset:current,controlOffset:null,headOffset:current,journalState:'ready'};store.saveProject({id:'p1',hostId:config.hostId,name:'History',path:config.roots[0],createdAt});store.saveSession(session);store.saveOffsetSnapshot({session:{...session,runtimeOffset:first},baseOffset:first,headOffset:current,data:'\x1b[',cols:80,rows:24});const firstPage=store.history('s1',current);assert.equal(firstPage.runs.length,200);assert.equal(firstPage.runsHasMore,true);const secondPage=store.history('s1',current,Number.MAX_SAFE_INTEGER,1,firstPage.runs.at(-1)!.runtimeOffset);assert.equal(secondPage.runs.length,1);assert.equal(secondPage.runsHasMore,false);store.close();const manager=new HostManager(config,{detect:async()=>[]});try{const state=await call(manager,config,'list');assert.equal(state.sessions[0].journalState,'integrity_failed')}finally{await manager.close();rmSync(dir,{recursive:true,force:true})}
});

test('all-runtime startup replay scans each retained interval only once',async()=>{
  const {dir,config}=fixture('linear-runs'),store=new HostStore({dir:config.dataDir!,secret:config.masterKey,hostId:config.hostId}),createdAt=new Date().toISOString();let current=0;for(let index=0;index<201;index++)current=store.journal.appendFact({streamId:'session:s1',kind:'runtime_started',payload:{cols:80,rows:24}}).offset;const session:Session={id:'s1',hostId:config.hostId,projectId:'p1',title:'Linear runs',agent:'codex',processState:'exited',activity:'idle',nativeSessionId:null,controller:null,cols:80,rows:24,createdAt,updatedAt:createdAt,archived:false,runtimeOffset:current,controlOffset:null,headOffset:current,journalState:'ready'};store.saveProject({id:'p1',hostId:config.hostId,name:'History',path:config.roots[0],createdAt});store.saveSession(session);store.close();const manager=new HostManager(config,{detect:async()=>[]});try{await call(manager,config,'list');const journal=manager.store.journal,original=journal.eventsAfter.bind(journal);let scanned=0;(journal as any).eventsAfter=(...args:any[])=>{const rows=original(args[0],args[1],args[2]);scanned+=rows.length;return rows};await (manager as any).verifyStartupReplays();assert.ok(scanned<=402,`startup replay scanned ${scanned} rows for 201 boundaries`)}finally{await manager.close();rmSync(dir,{recursive:true,force:true})}
});
