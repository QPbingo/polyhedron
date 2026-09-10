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
function setup(){const dir=realpathSync(mkdtempSync(join(tmpdir(),'poly-operations-'))),root=join(dir,'root');mkdirSync(root);dirs.push(dir);const config:HostConfig={hostId:'host-a',accountId:'account-a',hostToken:'host-secret-that-is-long-enough-1234',masterKey:'master-secret-that-never-leaves-host-1234',ipcToken:'ipc-secret-that-is-long-enough-1234',relayUrl:'ws://127.0.0.1/ws',name:'Host',roots:[root],dataDir:join(dir,'data')};return {dir,root,config,faults:new FaultSwitch()}}
async function call(manager:HostManager,config:HostConfig,clientId:string,method:string,params:Record<string,unknown>={}){const body={operationId:randomUUID(),...params};const grant=await new SignJWT({hostId:config.hostId,clientId,scope:'host',method,sessionId:body.sessionId}).setSubject(config.accountId).setIssuedAt().setExpirationTime('30s').setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(config.hostToken));return manager.rpc({type:'rpc',requestId:randomUUID(),clientId,method,params:body,grant,channelId:`channel-${clientId}`} as any)}
async function ready(manager:HostManager,config:HostConfig,root:string){const project=await call(manager,config,'a','addProject',{name:'Project',path:root});const session=await call(manager,config,'a','createSession',{projectId:project.id,title:'Session',agent:'codex'});await call(manager,config,'a','attach',{sessionId:session.id,lastAppliedOffset:0});const owner=await call(manager,config,'a','claimControl',{sessionId:session.id,runtimeOffset:session.runtimeOffset});return {project,session:owner}}

test('input request commits before PTY side effect and journal failure is fail closed',async()=>{
  const {dir,root,config,faults}=setup(),marker=join(dir,'input.txt');
  const manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e',`const fs=require('node:fs');process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(marker)},d));setInterval(()=>{},1000)`],env:{}})} as any);
  try{
    const {session}=await ready(manager,config,root);faults.point='request.beforeCommit';
    await assert.rejects(call(manager,config,'a','input',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'MUST_NOT_WRITE'}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    await new Promise(resolve=>setTimeout(resolve,80));assert.equal(existsSync(marker)?readFileSync(marker,'utf8'):'','');
    const state=await call(manager,config,'a','list',{});assert.equal(state.sessions[0].journalState,'unavailable');
  }finally{await manager.close()}
});

test('a side effect without a committed result is indeterminate and is never replayed',async()=>{
  const {dir,root,config,faults}=setup(),marker=join(dir,'input.txt');let manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e',`const fs=require('node:fs');process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(marker)},d));setInterval(()=>{},1000)`],env:{}})} as any);
  const operationId=randomUUID();
  try{
    const {session}=await ready(manager,config,root);faults.point='effect.after';
    await assert.rejects(call(manager,config,'a','input',{operationId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'WRITE_ONCE\r'}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    await new Promise(resolve=>setTimeout(resolve,80));assert.match(readFileSync(marker,'utf8'),/^WRITE_ONCE/);await manager.close();
    manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}})} as any);
    const operation=manager.store.journal.begin({streamId:`session:${session.id}`,operationId,actor:'channel-a',kind:'input',payload:{bytes:11,digest:manager.store.cipher.digest('WRITE_ONCE\r'),runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset}}).duplicate;
    assert.equal(operation?.status,'indeterminate');
    const state=await call(manager,config,'a','list');assert.match(state.sessions[0].warning,/结果不确定|不会自动重放/);
  }finally{await manager.close()}
});

test('a PTY write that throws after entering the side effect is durably indeterminate and never retried',async()=>{
  const {root,config}=setup(),manager=new HostManager(config,{detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','process.stdin.resume();setInterval(()=>{},1000)'],env:{}})} as any),operationId=randomUUID();
  try{
    const {session}=await ready(manager,config,root),runtime=(manager as any).runtimes.get(session.id);let writes=0;
    runtime.pty.write=()=>{writes++;throw new Error('write may have partially completed')};
    const params={operationId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'WRITE_UNKNOWN'};
    await assert.rejects(call(manager,config,'a','input',params),(error:any)=>error.code==='OPERATION_INDETERMINATE');
    assert.equal((manager.store.db.prepare("SELECT status FROM journal_operations WHERE operation_id=?").get(operationId) as any).status,'indeterminate');
    await assert.rejects(call(manager,config,'a','input',params),(error:any)=>error.code==='OPERATION_INDETERMINATE');assert.equal(writes,1);
  }finally{await manager.close()}
});

test('an indeterminate resize restores the last committed terminal geometry',async()=>{
  const {root,config}=setup(),manager=new HostManager(config,{detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','process.stdin.resume();setInterval(()=>{},1000)'],env:{}})} as any);
  try{
    const {session}=await ready(manager,config,root),runtime=(manager as any).runtimes.get(session.id),original=runtime.pty.resize.bind(runtime.pty);let calls=0;
    runtime.pty.resize=(cols:number,rows:number)=>{calls++;if(calls===1)throw new Error('resize may have partially completed');return original(cols,rows)};
    await assert.rejects(call(manager,config,'a','resize',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,cols:120,rows:40}),(error:any)=>error.code==='OPERATION_INDETERMINATE');
    assert.equal(runtime.terminal.term.cols,100);assert.equal(runtime.terminal.term.rows,30);assert.equal(calls,2);
  }finally{await manager.close()}
});

test('terminate is indeterminate when neither initial signal path can prove delivery',async()=>{
  const {root,config}=setup(),manager=new HostManager(config,{detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','process.stdin.resume();setInterval(()=>{},1000)'],env:{}})} as any),operationId=randomUUID();
  try{
    const {session}=await ready(manager,config,root),runtime=(manager as any).runtimes.get(session.id),kill=runtime.pty.kill;
    try{Object.defineProperty(runtime.pty,'pid',{value:2_147_483_646,configurable:true});runtime.pty.kill=()=>{throw new Error('signal delivery failed')};await assert.rejects(call(manager,config,'a','terminate',{operationId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,confirm:true}),(error:any)=>error.code==='OPERATION_INDETERMINATE');assert.equal((manager.store.db.prepare('SELECT status FROM journal_operations WHERE operation_id=?').get(operationId) as any).status,'indeterminate')}finally{delete runtime.pty.pid;runtime.pty.kill=kill}
  }finally{await manager.close()}
});

test('a committed result lost before response is recovered idempotently without a second side effect',async()=>{
  const {dir,root,config,faults}=setup(),marker=join(dir,'input-after-result.txt');let manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e',`const fs=require('node:fs');process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(marker)},d));setInterval(()=>{},1000)`],env:{}})} as any);const operationId=randomUUID();
  try{const {session}=await ready(manager,config,root);faults.point='result.afterCommit';const params={operationId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'COMMITTED_ONCE\r'};await assert.rejects(call(manager,config,'a','input',params),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');await new Promise(resolve=>setTimeout(resolve,80));assert.equal((readFileSync(marker,'utf8').match(/COMMITTED_ONCE/g)??[]).length,1);await manager.close();manager=new HostManager(config,{faults,detect:async()=>[]});await call(manager,config,'a','recoverJournal',{sessionId:session.id});assert.equal((await call(manager,config,'a','input',params)).accepted,true);await new Promise(resolve=>setTimeout(resolve,50));assert.equal((readFileSync(marker,'utf8').match(/COMMITTED_ONCE/g)??[]).length,1)}finally{await manager.close()}
});

test('explicit recovery verifies storage and replay before reopening an unavailable session',async()=>{
  const {root,config,faults}=setup();let context:any;
  const manager=new HostManager(config,{faults,detect:async()=>[],launch:async(options:any)=>{context=options;return {file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}}}} as any);
  try{
    const {session}=await ready(manager,config,root);
    await manager.hook(context.hookToken,{sessionId:session.id,runtimeToken:context.runtimeToken,event:'SessionStart',eventId:'native-id',nativeSessionId:randomUUID(),at:new Date().toISOString()});
    faults.point='request.beforeCommit';await assert.rejects(call(manager,config,'a','input',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'blocked'}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    await assert.rejects(call(manager,config,'a','resume',{sessionId:session.id}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    const recovered=await call(manager,config,'a','recoverJournal',{sessionId:session.id});assert.equal(recovered.journalState,'ready');assert.equal(recovered.warning,null);
    assert.equal(manager.store.journal.eventsAfter(`session:${session.id}`,0).at(-1)?.kind,'journal_recovered');
  }finally{await manager.close()}
});

test('explicit recovery finalizes a live pending side effect as indeterminate',async()=>{
  const {root,config,faults}=setup(),manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','process.stdin.resume();setInterval(()=>{},1000)'],env:{}})} as any),operationId=randomUUID();
  try{
    const {session}=await ready(manager,config,root);faults.point='result.beforeCommit';
    const params={operationId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'UNKNOWN_ONCE'};
    await assert.rejects(call(manager,config,'a','input',params),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    const recovered=await call(manager,config,'a','recoverJournal',{sessionId:session.id});assert.equal(recovered.journalState,'ready');assert.match(recovered.warning,/结果不确定|不会自动重放/);
    await assert.rejects(call(manager,config,'a','input',params),(error:any)=>error.code==='OPERATION_INDETERMINATE');
    assert.equal((manager.store.db.prepare("SELECT COUNT(*) count FROM journal_operations WHERE status='requested'").get() as any).count,0);
  }finally{await manager.close()}
});

test('recovery restores the PTY to the last committed terminal geometry',async()=>{
  const {root,config,faults}=setup(),manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e',"process.stdin.on('data',()=>process.stdout.write(process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));setInterval(()=>{},1000)"],env:{}})} as any);
  try{
    const {session}=await ready(manager,config,root);faults.point='result.beforeCommit';
    await assert.rejects(call(manager,config,'a','resize',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,cols:120,rows:40}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    const recovered=await call(manager,config,'a','recoverJournal',{sessionId:session.id});assert.equal(recovered.cols,100);assert.equal(recovered.rows,30);
    await call(manager,config,'a','input',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'size\r'});
    const end=Date.now()+3000;while(Date.now()<end&&!manager.store.journal.eventsAfter(`session:${session.id}`,0).some(event=>event.kind==='pty_output'&&String((event.payload as any)?.data).includes('100x30')))await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(manager.store.journal.eventsAfter(`session:${session.id}`,0).some(event=>event.kind==='pty_output'&&String((event.payload as any)?.data).includes('100x30')),true);
  }finally{await manager.close()}
});

test('recovery terminates a spawned runtime whose runtime_started result never committed',async()=>{
  const {root,config,faults}=setup(),manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}})} as any);
  try{
    const project=await call(manager,config,'a','addProject',{name:'Project',path:root});faults.point='result.beforeCommit';
    await assert.rejects(call(manager,config,'a','createSession',{projectId:project.id,title:'Uncommitted',agent:'codex'}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');
    const failed=(await call(manager,config,'a','list')).sessions[0],recovered=await call(manager,config,'a','recoverJournal',{sessionId:failed.id});
    assert.equal(recovered.processState,'failed');assert.equal(recovered.journalState,'ready');assert.match(recovered.warning,/未提交的本地进程已终止/);
    assert.equal((manager.store.db.prepare("SELECT COUNT(*) count FROM journal_operations WHERE status='requested'").get() as any).count,0);
  }finally{await manager.close()}
});

test('a durable failure latch survives restart until explicit recovery succeeds',async()=>{
  const {root,config,faults}=setup();let manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}})} as any);
  try{
    const {session}=await ready(manager,config,root);faults.point='request.beforeCommit';
    await assert.rejects(call(manager,config,'a','input',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'blocked'}),(error:any)=>error.code==='JOURNAL_UNAVAILABLE');assert.equal(manager.store.journalFailureLatched(),true);
    await manager.close();manager=new HostManager(config,{faults,detect:async()=>[]});
    const unavailable=(await call(manager,config,'a','list')).sessions[0];assert.equal(unavailable.journalState,'unavailable');
    await call(manager,config,'a','recoverJournal',{sessionId:session.id});assert.equal(manager.store.journalFailureLatched(),false);
    await manager.close();manager=new HostManager(config,{faults,detect:async()=>[]});assert.equal((await call(manager,config,'a','list')).sessions[0].journalState,'ready');
  }finally{await manager.close()}
});

test('an empty Host can clear a durable journal failure through host-level recovery',async()=>{
  const {config,faults}=setup(),store=new (await import('../src/host/store.js')).HostStore({dir:config.dataDir!,secret:config.masterKey,hostId:config.hostId});store.setJournalFailureLatch(true);store.close();const manager=new HostManager(config,{faults,detect:async()=>[]});
  try{const before=await call(manager,config,'a','list');assert.equal(before.sessions.length,0);assert.equal(before.host.recoveryRequired,true);assert.deepEqual(await call(manager,config,'a','recoverHostJournal'),{ok:true});assert.equal((await call(manager,config,'a','list')).host.recoveryRequired,false);assert.equal(manager.store.journalFailureLatched(),false)}finally{await manager.close()}
});

test('startup storage verification failure stays fail closed across requests and restart',async()=>{
  const {config,faults}=setup(),seed=new HostManager(config,{faults,detect:async()=>[]});await call(seed,config,'a','list');const before=(seed.store.db.prepare('SELECT COUNT(*) count FROM journal_events').get() as any).count;await seed.close();assert.throws(()=>new HostManager(config,{faults,detect:async()=>[],verifyStorage:()=>{throw new Error('quick_check failed')}}),/quick_check failed/);const db=new (await import('node:sqlite')).DatabaseSync(join(config.dataDir!,'host.sqlite'));try{assert.equal((db.prepare('SELECT COUNT(*) count FROM journal_events').get() as any).count,before)}finally{db.close()}const manager=new HostManager(config,{faults,detect:async()=>[]});try{assert.equal((await call(manager,config,'a','list')).host.recoveryRequired,false)}finally{await manager.close()}
});

test('retrying an applied recovery operation retries durable latch cleanup',async()=>{
  const {root,config,faults}=setup(),manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}})} as any),operationId=randomUUID();
  try{const {session}=await ready(manager,config,root);faults.point='request.beforeCommit';await assert.rejects(call(manager,config,'a','input',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'blocked'}));const original=manager.store.setJournalFailureLatch.bind(manager.store),replacement=(failed:boolean)=>{if(!failed)throw new Error('latch unavailable');return original(failed)};manager.store.setJournalFailureLatch=replacement;
    await assert.rejects(call(manager,config,'a','recoverJournal',{operationId,sessionId:session.id}),(error:any)=>error.code==='RECOVERY_FAILED');assert.equal((await call(manager,config,'a','list')).sessions[0].journalState,'unavailable');manager.store.setJournalFailureLatch=original;
    const recovered=await call(manager,config,'a','recoverJournal',{operationId,sessionId:session.id});assert.equal(recovered.journalState,'ready');assert.equal(manager.store.journalFailureLatched(),false);
  }finally{await manager.close()}
});

test('exit fact failure recovers as interrupted instead of a running ghost',async()=>{
  const {root,config,faults}=setup(),manager=new HostManager(config,{faults,detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}})} as any);
  try{const {session}=await ready(manager,config,root);faults.point='fact.beforeCommit';await call(manager,config,'a','terminate',{sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,confirm:true});const end=Date.now()+3000;while(Date.now()<end&&(await call(manager,config,'a','list')).sessions[0].journalState==='ready')await new Promise(resolve=>setTimeout(resolve,20));const recovered=await call(manager,config,'a','recoverJournal',{sessionId:session.id});assert.equal(recovered.journalState,'ready');assert.equal(recovered.processState,'interrupted');await assert.rejects(call(manager,config,'a','claimControl',{sessionId:session.id,runtimeOffset:session.runtimeOffset}),(error:any)=>error.code==='NOT_RUNNING')}
  finally{await manager.close()}
});

test('operation collision is audited as a protocol violation without degrading the session',async()=>{
  const {root,config}=setup(),manager=new HostManager(config,{detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}})} as any);
  try{
    const {session}=await ready(manager,config,root),operationId=randomUUID();
    await call(manager,config,'a','input',{operationId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'first'});
    await assert.rejects(call(manager,config,'a','input',{operationId,sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:session.controlOffset,data:'different'}),(error:any)=>error.code==='OPERATION_COLLISION');
    const state=await call(manager,config,'a','list');assert.equal(state.sessions[0].journalState,'ready');assert.equal(manager.store.journal.eventsAfter(`session:${session.id}`,0).some(event=>event.kind==='operation_collision'),true);
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
