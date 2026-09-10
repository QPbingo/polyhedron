import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import {HostManager} from '../src/host/manager.js';
import type {HostConfig} from '../src/shared/types.js';
const dirs:string[]=[];
test.after(()=>dirs.forEach(d=>rmSync(d,{recursive:true,force:true})));
function setup(){const dir=realpathSync(mkdtempSync(join(tmpdir(),'polyhedron-host-test-')));dirs.push(dir);const root=join(dir,'root');mkdirSync(root);const config:HostConfig={hostId:'host-a',accountId:'account-a',hostToken:'test-host-secret-long-enough-123456789',masterKey:'test-master-secret-never-relayed-123456789',ipcToken:'ipc-secret',relayUrl:'ws://127.0.0.1:3001/ws/host',name:'Test Host',roots:[root],dataDir:join(dir,'data')};return {dir,root,config};}
async function grant(config:HostConfig,clientId:string,method:string,params:Record<string,unknown>={}){return new SignJWT({hostId:config.hostId,clientId,scope:'host',method,sessionId:params.sessionId}).setSubject(config.accountId).setIssuedAt().setExpirationTime('30s').setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(config.hostToken));}
async function call(m:HostManager,c:HostConfig,clientId:string,method:string,params:Record<string,unknown>={}){const body={operationId:randomUUID(),...params};return m.rpc({type:'rpc',requestId:randomUUID(),clientId,channelId:`channel-${clientId}`,method,params:body,grant:await grant(c,clientId,method,body)});}
const launch=async()=>({file:process.execPath,args:['-e',"process.stdin.setEncoding('utf8'); process.stdin.on('data',x=>process.stdout.write('RESULT:'+x)); process.stdout.write('READY\\r\\n')"],env:{}});
async function until(fn:()=>boolean){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,20));}}
test('real project registration rejects symlink escapes and duplicate canonical directories',async()=>{const {dir,root,config}=setup();const outside=join(dir,'outside');mkdirSync(outside);symlinkSync(outside,join(root,'escape'));const m=new HostManager(config,{launch,detect:async()=>[]});try{const p:any=await call(m,config,'a','addProject',{name:'App',path:root});assert.equal(p.path,root);await assert.rejects(call(m,config,'a','addProject',{name:'Other',path:root+'/.'}),/已添加/);await assert.rejects(call(m,config,'a','addProject',{name:'Escape',path:join(root,'escape')}),/授权/);await assert.rejects(call(m,config,'a','addProject',{name:'Missing',path:join(root,'missing')}),/目录/);}finally{await m.close();}});
test('expired, foreign-account and purpose-swapped grants cannot access local metadata',async()=>{const {config}=setup();const m=new HostManager(config,{launch,detect:async()=>[]});try{for(const extra of [{exp:1},{sub:'other-account'},{hostId:'other-host'},{method:'input'}]){const token=await new SignJWT({sub:config.accountId,hostId:config.hostId,clientId:'a',scope:'host',method:'list',exp:Math.floor(Date.now()/1000)+30,...extra}).setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(config.hostToken));await assert.rejects(m.rpc({type:'rpc',requestId:'x',clientId:'a',method:'list',params:{},grant:token}));}}finally{await m.close();}});
test('real PTY survives detach, rejects old controller, deduplicates input, snapshots and persists exit history',async()=>{const {root,config}=setup();const events:any[]=[];let m=new HostManager(config,{launch,detect:async()=>[]});m.on('event',e=>events.push(e));try{const p:any=await call(m,config,'a','addProject',{name:'App',path:root});const s:any=await call(m,config,'a','createSession',{projectId:p.id,title:'PTY',agent:'codex'});const started=m.store.journal.eventsAfter(`session:${s.id}`,0).find(event=>event.kind==='runtime_started')!;assert.equal(started.runtimeOffset,started.offset);await call(m,config,'a','attach',{sessionId:s.id,lastAppliedOffset:0});let owner:any=await call(m,config,'a','claimControl',{sessionId:s.id,runtimeOffset:s.runtimeOffset});const input={operationId:randomUUID(),sessionId:s.id,runtimeOffset:s.runtimeOffset,controlOffset:owner.controlOffset,data:'hello\r'};assert.equal((await call(m,config,'a','input',input)).accepted,true);assert.equal((await call(m,config,'a','input',input)).accepted,true);await until(()=>events.some(e=>e.kind==='pty_output'&&e.data.includes('RESULT:hello')));assert.equal(events.filter(e=>e.kind==='pty_output'&&e.data.includes('RESULT:hello')).length,1);await call(m,config,'b','attach',{sessionId:s.id,lastAppliedOffset:0});owner=await call(m,config,'b','claimControl',{sessionId:s.id,runtimeOffset:s.runtimeOffset});await assert.rejects(call(m,config,'a','input',{...input,operationId:randomUUID()}),/操作权/);await assert.rejects(call(m,config,'b','resize',{sessionId:s.id,runtimeOffset:0,controlOffset:owner.controlOffset,cols:100,rows:30}),/运行/);await call(m,config,'b','detach',{sessionId:s.id});const snapshot:any=await call(m,config,'c','attach',{sessionId:s.id,lastAppliedOffset:0});assert.equal(snapshot.session.runtimeOffset,s.runtimeOffset);assert.equal(snapshot.session.processState,'running');assert.match(snapshot.data,/RESULT:hello/);assert.ok(snapshot.headOffset>=snapshot.baseOffset);await call(m,config,'c','eventAck',{sessionId:s.id,appliedOffset:snapshot.headOffset});assert.deepEqual(await call(m,config,'c','eventAck',{sessionId:s.id,appliedOffset:0}),{ok:true});await assert.rejects(call(m,config,'c','createSession',{projectId:p.id,title:'Conflict',agent:'codex'}),/同一目录/);owner=await call(m,config,'c','claimControl',{sessionId:s.id,runtimeOffset:s.runtimeOffset});await call(m,config,'c','terminate',{sessionId:s.id,runtimeOffset:s.runtimeOffset,controlOffset:owner.controlOffset,confirm:true});await until(()=>events.some(e=>e.session?.processState==='exited'));const history:any=await call(m,config,'c','history',{sessionId:s.id,runtimeOffset:s.runtimeOffset});assert.ok(history.entries.some((e:any)=>e.data.includes('RESULT:hello')));await m.close();m=new HostManager(config,{launch,detect:async()=>[]});const state:any=await call(m,config,'a','list');assert.equal(state.projects[0].id,p.id);assert.equal(state.sessions[0].id,s.id);assert.equal(state.sessions[0].processState,'exited');await assert.rejects(call(m,config,'a','resume',{sessionId:s.id}),/原生会话/);}finally{await m.close();}});
test('host settings persist and reject invalid retention without widening authorized roots',async()=>{const {config}=setup();let m=new HostManager(config,{launch,detect:async()=>[]});try{await assert.rejects(call(m,config,'a','configureHost',{historyDays:0}),/告警/);const settings=await call(m,config,'a','configureHost',{preventSleep:false,historyDays:7,maxHistoryBytes:64*1024*1024});assert.equal(settings.historyDays,7);await m.close();m=new HostManager(config,{launch,detect:async()=>[]});const state=await call(m,config,'a','list');assert.equal(state.host.settings.historyDays,7);assert.deepEqual(state.host.roots,config.roots);}finally{await m.close();}});

test('operation id stays idempotent across encrypted channel replacement for the same browser login',async()=>{
 const {root,config}=setup(),m=new HostManager(config,{launch,detect:async()=>[]}),expires=Date.now()+30_000,actorId='browser-login-a';
 const secure=(channelId:string,method:string,params:Record<string,unknown>,operationId=randomUUID())=>m.secureRpc('tab-a',channelId,randomUUID(),method,{operationId,...params},expires);
 try{
  await m.openChannel('channel-a',expires,actorId);
  const project:any=await secure('channel-a','addProject',{name:'App',path:root});
  const session:any=await secure('channel-a','createSession',{projectId:project.id,title:'PTY',agent:'codex'});
  await secure('channel-a','attach',{sessionId:session.id,lastAppliedOffset:0});
  const owner:any=await secure('channel-a','claimControl',{sessionId:session.id,runtimeOffset:session.runtimeOffset});
  const operationId=randomUUID(),input={sessionId:session.id,runtimeOffset:session.runtimeOffset,controlOffset:owner.controlOffset,data:'only-once\r'};
  assert.equal((await secure('channel-a','input',input,operationId)).accepted,true);
  await until(()=>m.store.journal.eventsAfter(`session:${session.id}`,0).some(event=>event.kind==='pty_output'&&String((event.payload as any)?.data).includes('RESULT:only-once')));
  await m.closeChannel('tab-a','channel-a');
  await m.openChannel('channel-b',expires,actorId);
  assert.equal((await secure('channel-b','input',input,operationId)).accepted,true);
  await new Promise(resolve=>setTimeout(resolve,60));
  const outputs=m.store.journal.eventsAfter(`session:${session.id}`,0).filter(event=>event.kind==='pty_output'&&String((event.payload as any)?.data).includes('RESULT:only-once'));
  assert.equal(outputs.length,1);
 }finally{await m.close()}
});

test('host list exposes exact local storage totals and per-session journal usage without pruning',async()=>{
 const {root,config}=setup(),m=new HostManager(config,{launch,detect:async()=>[]});
 try{
  const project:any=await call(m,config,'a','addProject',{name:'App',path:root});
  const session:any=await call(m,config,'a','createSession',{projectId:project.id,title:'Storage',agent:'codex'});
  const state:any=await call(m,config,'a','list');
  assert.ok(state.host.storage.totalBytes>0);
  assert.equal(state.host.storage.maxHistoryBytes,128*1024*1024);
  assert.equal(state.host.storage.historyDays,30);
  assert.equal(typeof state.host.storage.warning,'boolean');
  assert.ok(state.sessions.find((item:any)=>item.id===session.id).historyBytes>0);
  assert.equal(m.store.journal.eventsAfter(`session:${session.id}`,0).some(event=>event.kind==='history_pruned'),false);
 }finally{await m.close()}
});

test('directory picker lists authorized folders only and keeps navigation inside roots',async()=>{
 const {dir,root,config}=setup();mkdirSync(join(root,'项目 A'));mkdirSync(join(root,'.hidden'));writeFileSync(join(root,'secret.txt'),'must not read');mkdirSync(join(dir,'outside'));symlinkSync(join(dir,'outside'),join(root,'escape'));symlinkSync(join(root,'项目 A'),join(root,'alias'));
 const m=new HostManager(config,{launch,detect:async()=>[]});
 try{
  const roots=await call(m,config,'a','listDirectories');assert.equal(roots.path,null);assert.deepEqual(roots.entries.map((e:any)=>e.path),[root]);
  const operationId=randomUUID(),repeatParams={operationId,path:root};
  assert.deepEqual(await call(m,config,'a','listDirectories',repeatParams),await call(m,config,'a','listDirectories',repeatParams));
  const list=await call(m,config,'a','listDirectories',{path:root});assert.equal(list.parent,null);assert.equal(list.path,root);assert.deepEqual(list.entries.map((e:any)=>e.name).sort(),['.hidden','alias','项目 A'].sort());
  assert.equal(list.entries.find((e:any)=>e.name==='alias').path,join(root,'项目 A'));
  const child=await call(m,config,'a','listDirectories',{path:join(root,'项目 A')});assert.equal(child.parent,root);assert.deepEqual(child.entries,[]);
  await assert.rejects(call(m,config,'a','listDirectories',{path:join(root,'escape')}),/授权/);
  await assert.rejects(call(m,config,'a','listDirectories',{path:root+'/..'}),/授权/);
  await assert.rejects(call(m,config,'a','listDirectories',{path:join(root,'secret.txt')}),/目录/);
 }finally{await m.close();}
});
