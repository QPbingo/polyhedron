import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import {HostManager} from '../src/host/manager.js';
import type {HostConfig} from '../src/shared/types.js';
import type {JournalFaultPoint} from '../src/host/journal.js';

class FaultSwitch{point:JournalFaultPoint|null=null;hit(point:JournalFaultPoint){if(this.point===point){this.point=null;throw new Error(`injected ${point}`)}}}
const dirs:string[]=[];test.after(()=>dirs.forEach(dir=>rmSync(dir,{recursive:true,force:true})));
function setup(){const dir=realpathSync(mkdtempSync(join(tmpdir(),'poly-operations-'))),root=join(dir,'root');mkdirSync(root);dirs.push(dir);const config:HostConfig={hostId:'host-a',accountId:'account-a',hostToken:'host-secret-that-is-long-enough-1234',ipcToken:'ipc-secret-that-is-long-enough-1234',relayUrl:'ws://127.0.0.1/ws',name:'Host',roots:[root],dataDir:join(dir,'data')};return {dir,root,config,faults:new FaultSwitch()}}
async function call(manager:HostManager,config:HostConfig,clientId:string,method:string,params:Record<string,unknown>={}){const body={operationId:randomUUID(),...params};const grant=await new SignJWT({hostId:config.hostId,clientId,scope:'host',method,sessionId:body.sessionId}).setSubject(config.accountId).setIssuedAt().setExpirationTime('30s').setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(config.hostToken));return manager.rpc({type:'rpc',requestId:randomUUID(),clientId,method,params:body,grant,channelId:`channel-${clientId}`} as any)}
async function ready(manager:HostManager,config:HostConfig,root:string){const project=await call(manager,config,'a','addProject',{name:'Project',path:root});const session=await call(manager,config,'a','createSession',{projectId:project.id,title:'Session',agent:'codex'});await call(manager,config,'a','attach',{sessionId:session.id,lastAppliedOffset:0});const owner=await call(manager,config,'a','claimControl',{sessionId:session.id,runtimeOffset:session.runtimeOffset});return {project,session:owner}}

test('input request commits before PTY side effect and journal failure is fail closed',async()=>{
  const {dir,root,config,faults}=setup(),marker=join(dir,'input.txt');
  const manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e',`const fs=require('node:fs');process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(marker)},d));setInterval(()=>{},1000)`],env:{}})} as any);
  try{
    const {session}=await ready(manager,config,root);faults.point='request.beforeCommit';
    await assert.rejects(call(manager,config,'a','input',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'MUST_NOT_WRITE'}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    await new Promise(resolve=>setTimeout(resolve,80));assert.equal(existsSync(marker)?readFileSync(marker,'utf8'):'','');
    const state=await call(manager,config,'a','authorize',{});assert.deepEqual(state,{ok:true});
  }finally{await manager.close()}
});

test('a side effect without a committed result is indeterminate and is never replayed',async()=>{
  const {dir,root,config,faults}=setup(),marker=join(dir,'input.txt');let manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e',`const fs=require('node:fs');process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(marker)},d));setInterval(()=>{},1000)`],env:{}})} as any);
  const operationId=randomUUID();
  try{
    const {session}=await ready(manager,config,root);faults.point='result.beforeCommit';
    await assert.rejects(call(manager,config,'a','input',{operationId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'WRITE_ONCE\r'}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    await new Promise(resolve=>setTimeout(resolve,80));assert.match(readFileSync(marker,'utf8'),/^WRITE_ONCE/);await manager.close();
    manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}})} as any);
    const operation=manager.store.journal.begin({streamId:`session:${session.id}`,operationId,actor:'channel-a',kind:'input',payload:{bytes:11,digest:manager.store.cipher.digest('WRITE_ONCE\r'),runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset}}).duplicate;
    assert.equal(operation?.status,'indeterminate');
  }finally{await manager.close()}
});

test('PTY output is committed before broadcast and storage failure broadcasts no bytes',async()=>{
  const {root,config,faults}=setup();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  const manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>{await gate;return {file:process.execPath,args:['-e',"process.stdout.write('OUTPUT_SENTINEL');setInterval(()=>{},1000)"],env:{}}}} as any);const events:any[]=[];manager.on('event',event=>events.push(event));
  try{
    const project=await call(manager,config,'a','addProject',{name:'P',path:root});const creating=call(manager,config,'a','createSession',{projectId:project.id,title:'S',agent:'codex'});faults.point='fact.beforeCommit';release();await creating;await new Promise(resolve=>setTimeout(resolve,120));
    assert.equal(events.some(event=>event.kind==='pty_output'&&event.data?.includes('OUTPUT_SENTINEL')),false);
    assert.equal((await call(manager,config,'a','list')).sessions[0].journalState,'unavailable');
  }finally{await manager.close()}
});

test('Hook identity, dedupe and Agent state commit atomically',async()=>{
  const {root,config,faults}=setup();let launchContext:any;
  const manager=new HostManager(config,{faults,detect:async()=>[],launch:async(context:any)=>{launchContext=context;return {file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}}}} as any);
  try{
    const {session}=await ready(manager,config,root);faults.point='fact.beforeCommit';
    await assert.rejects(manager.hook(launchContext.hookToken,{sessionId:session.id,runtimeToken:launchContext.runtimeToken,event:'PermissionRequest',eventId:'hook-1',toolName:'Bash',at:new Date().toISOString()}));
    assert.notEqual((await call(manager,config,'a','list')).sessions[0].activity,'approval');
  }finally{await manager.close()}
});
