import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import {TerminalState} from '../src/host/terminal.js';
import {HostManager} from '../src/host/manager.js';
import type {HostConfig} from '../src/shared/types.js';
import type {LaunchOptions} from '../src/adapters/index.js';

async function call(m:HostManager,c:HostConfig,method:string,params:Record<string,unknown>={}) {
  const grant=await new SignJWT({hostId:c.hostId,clientId:'review',scope:'host',method,sessionId:params.sessionId,runtimeEpoch:params.runtimeEpoch}).setSubject(c.accountId).setIssuedAt().setExpirationTime('30s').setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(c.hostToken));
  return m.rpc({type:'rpc',requestId:randomUUID(),clientId:'review',method,params,grant});
}
function setup(){
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'poly-host-review-'))),root=join(dir,'root');mkdirSync(root);
  const config:HostConfig={hostId:'review-host',accountId:'review-account',hostToken:'review-secret-with-adequate-length',ipcToken:'ipc-secret',relayUrl:'ws://127.0.0.1:3001/ws/host',name:'Review',roots:[root],dataDir:join(dir,'data')};return {dir,root,config};
}
async function until(fn:()=>boolean){const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,20));}}

test('snapshot restoration survives ESC restarting an incomplete CSI across PTY chunks',async()=>{
  const live=new TerminalState(),replica=new TerminalState();
  try {
    await live.write('\x1b[1\x1b[');
    await replica.write(live.snapshot());
    const tail=await live.write('31mR');
    await replica.write(tail);
    assert.equal(replica.term.buffer.active.getLine(0)?.translateToString(true),live.term.buffer.active.getLine(0)?.translateToString(true));
    assert.equal(replica.term.buffer.active.getLine(0)?.getCell(0)?.getFgColor(),live.term.buffer.active.getLine(0)?.getCell(0)?.getFgColor());
  } finally { live.close(); replica.close(); }
});

test('approval without tool ID only clears on matching tool name or authoritative Stop',async()=>{
  const {dir,root,config}=setup();let context:LaunchOptions|undefined;
  const m=new HostManager(config,{detect:async()=>[],launch:async options=>{context=options;return {file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}};}});
  try {
    const p=await call(m,config,'addProject',{name:'Review',path:root});
    const s=await call(m,config,'createSession',{projectId:p.id,title:'Hook',agent:'codex'});
    await m.hook(context!.hookToken,{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,event:'PermissionRequest',eventId:'approval-without-tool-id',toolName:'Bash',at:new Date().toISOString()});
    assert.equal((await call(m,config,'list')).sessions[0].activity,'approval');
    await m.hook(context!.hookToken,{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,event:'PostToolUse',eventId:'other-tool-finished',toolUseId:'tool-other',toolName:'Read',at:new Date().toISOString()});
    assert.equal((await call(m,config,'list')).sessions[0].activity,'approval');
    await m.hook(context!.hookToken,{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,event:'PostToolUse',eventId:'approved-tool-finished',toolUseId:'tool-123',toolName:'Bash',at:new Date().toISOString()});
    assert.equal((await call(m,config,'list')).sessions[0].activity,'working');
    await m.hook(context!.hookToken,{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,event:'PermissionRequest',eventId:'missing-correlations',at:new Date().toISOString()});
    await m.hook(context!.hookToken,{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,event:'PostToolUse',eventId:'unprovable-tool-finished',toolUseId:'tool-456',toolName:'Bash',at:new Date().toISOString()});
    assert.equal((await call(m,config,'list')).sessions[0].activity,'approval');
    await m.hook(context!.hookToken,{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,event:'Stop',eventId:'turn-stopped',at:new Date().toISOString()});
    assert.equal((await call(m,config,'list')).sessions[0].activity,'done');
  } finally { await m.close();rmSync(dir,{recursive:true,force:true}); }
});

test('terminate kills remaining managed descendants after the direct PTY process exits',async()=>{
  const {dir,root,config}=setup();let childPid=0,exited=false;
  const child="process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});process.stdout.write('CHILD:'+process.pid+'\\n');setInterval(()=>{},1000)";
  const parent=`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore']});c.stdout.on('data',d=>process.stdout.write(d));setInterval(()=>{},1000)`;
  const m=new HostManager(config,{detect:async()=>[],launch:async()=>({file:process.execPath,args:['-e',parent],env:{}})});
  m.on('event',e=>{if(e.event==='output'){const match=/CHILD:(\d+)/.exec(e.data);if(match)childPid=Number(match[1]);}if(e.session?.processState==='exited')exited=true;});
  try {
    const p=await call(m,config,'addProject',{name:'Review',path:root});const s=await call(m,config,'createSession',{projectId:p.id,title:'Tree',agent:'codex'});
    await call(m,config,'attach',{sessionId:s.id});const owner=await call(m,config,'claimControl',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch});
    await until(()=>!!childPid);
    await call(m,config,'terminate',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,controlEpoch:owner.controlEpoch,confirm:true});
    await until(()=>exited);await new Promise(r=>setTimeout(r,1800));
    assert.throws(()=>process.kill(childPid,0),{code:'ESRCH'});
  } finally { if(childPid)try{process.kill(childPid,'SIGKILL');}catch{}await m.close();rmSync(dir,{recursive:true,force:true}); }
});

test('a resume rejected by the process limit leaves the previous exited session recoverable',async()=>{
  const {dir,root,config}=setup();config.maxSessions=1;const contexts=new Map<string,LaunchOptions>();
  const m=new HostManager(config,{detect:async()=>[],launch:async options=>{contexts.set(options.sessionId,options);return {file:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}};}});
  let exited=false;m.on('event',e=>{if(e.session?.processState==='exited')exited=true;});
  try {
    const p=await call(m,config,'addProject',{name:'Review',path:root});
    const first=await call(m,config,'createSession',{projectId:p.id,title:'First',agent:'codex'});
    await m.hook(contexts.get(first.id)!.hookToken,{sessionId:first.id,runtimeEpoch:first.runtimeEpoch,event:'SessionStart',eventId:'native-id-capture',nativeSessionId:randomUUID(),at:new Date().toISOString()});
    await call(m,config,'attach',{sessionId:first.id});const owner=await call(m,config,'claimControl',{sessionId:first.id,runtimeEpoch:first.runtimeEpoch});
    await call(m,config,'terminate',{sessionId:first.id,runtimeEpoch:first.runtimeEpoch,controlEpoch:owner.controlEpoch,confirm:true});await until(()=>exited);
    await call(m,config,'createSession',{projectId:p.id,title:'Second',agent:'codex'});
    await assert.rejects(call(m,config,'resume',{sessionId:first.id}),/上限/);
    assert.equal((await call(m,config,'list')).sessions.find((s:any)=>s.id===first.id).processState,'exited');
  } finally {await m.close();rmSync(dir,{recursive:true,force:true});}
});

test('history reports truncation when retention has removed every segment',async()=>{
  const {dir,config}=setup();
  const {HostStore}=await import('../src/host/store.js');
  const store=new HostStore(config.dataDir!,1,30);
  try {
    store.append({id:'history-session',runtimeEpoch:'old-runtime'} as any,1,'older terminal output');
    const history=store.history('history-session','old-runtime');
    assert.deepEqual(history.entries,[]);
    assert.equal(history.truncated,true);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('C1 CSI can restart an unfinished OSC or DCS without indefinitely withholding visible output',async()=>{
  for (const sequence of ['\x1b]title\x9b31mR','\x1bPstuff\x9b31mR']) {
    const state=new TerminalState();
    try {
      await state.write(sequence);
      assert.equal(state.term.buffer.active.getLine(0)?.translateToString(true),'R');
    } finally {state.close();}
  }
});
