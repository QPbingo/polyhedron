import {EventEmitter} from 'node:events';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {jwtVerify} from 'jose';
import * as pty from 'node-pty';
import {join} from 'node:path';
import {hostname,homedir} from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';
import {HostStore} from './store.js';
import {TerminalState} from './terminal.js';
import {authorizedPath,title,listDirectories} from './paths.js';
import {Fault,type Agent,type AgentInfo,type HostConfig,type Project,type Rpc,type Session,type Snapshot} from '../shared/types.js';
import {buildLaunch,detectAgents} from '../adapters/index.js';
type Launch=typeof buildLaunch;
type Subscriber={expires:number;ack:number;pending:{seq:number;bytes:number}[];bytes:number};
type Runtime={session:Session;terminal:TerminalState;pty:pty.IPty;queue:Promise<unknown>;queuedBytes:number;seq:number;hookToken:string;subscribers:Map<string,Subscriber>;inputSeq:number;permissions:Map<string,string|undefined>;lastHookAt:number;lastSnapshot:number;closing:boolean};
const now=()=>new Date().toISOString();
export class HostManager extends EventEmitter {
 readonly store:HostStore;
 private projects=new Map<string,Project>();private sessions=new Map<string,Session>();private runtimes=new Map<string,Runtime>();
 private authorizations=new Map<string,number>();private serial:Promise<unknown>=Promise.resolve();private pendingRequests=0;private timer:NodeJS.Timeout;private closed=false;private lastPrune=0;private sleeper?:ChildProcess;
 private launch:Launch;private detect:()=>Promise<AgentInfo[]>;private agents?:Promise<AgentInfo[]>;
 constructor(readonly config:HostConfig,deps:{launch?:Launch;detect?:()=>Promise<AgentInfo[]>}={}){
  super();this.launch=deps.launch??buildLaunch;this.detect=deps.detect??detectAgents;
  this.store=new HostStore(config.dataDir??join(homedir(),'.polyhedron'),config.maxHistoryBytes,config.historyDays);
  Object.assign(this.config,this.store.preferences());this.store.configure(this.settings());
  this.store.projects().forEach(p=>this.projects.set(p.id,p));
  for(const s of this.store.sessions()){if(['running','starting'].includes(s.processState)){s.processState='interrupted';s.activity='unknown';s.warning='执行服务已重启，原进程已中断，请手动恢复原生会话';}s.controller=null;s.controlEpoch++;this.store.saveSession(s);this.sessions.set(s.id,s);}
  this.timer=setInterval(()=>this.expire(),1000);this.timer.unref();
 }
 async rpc(request:Rpc):Promise<any>{
  if(this.pendingRequests>=256)throw new Fault('BUSY','主机请求过多，请稍后重试');this.pendingRequests++;
  // Queue validation together with mutation: simultaneous claims cannot interleave.
  const run=async()=>{
   if(this.closed)throw new Fault('SHUTTING_DOWN','主机服务正在关闭');
   let payload:any;try{({payload}=await jwtVerify(request.grant,new TextEncoder().encode(this.config.hostToken),{algorithms:['HS256'],subject:this.config.accountId}));}catch{throw new Fault('UNAUTHORIZED','主机授权已失效');}
   if(payload.hostId!==this.config.hostId||payload.clientId!==request.clientId||payload.scope!=='host'||payload.method!==request.method||payload.sessionId!==request.params?.sessionId||payload.runtimeEpoch!==request.params?.runtimeEpoch||typeof payload.exp!=='number'||payload.exp*1000>Date.now()+31000)throw new Fault('UNAUTHORIZED','主机授权与本次操作不匹配');
   const expires=payload.exp*1000;this.authorizations.set(request.clientId,expires);
   for(const r of this.runtimes.values()){const sub=r.subscribers.get(request.clientId);if(sub)sub.expires=expires;}
   return this.dispatch(request.clientId,request.method,request.params??{},expires);
  };
  const task=this.serial.then(run);this.serial=task.catch(()=>{});return task.finally(()=>{this.pendingRequests--;});
 }
 private settings(){return {preventSleep:this.config.preventSleep??false,historyDays:this.config.historyDays??30,maxHistoryBytes:this.config.maxHistoryBytes??128*1024*1024};}
 private save(s:Session){s.updatedAt=now();this.store.saveSession(s);this.emit('event',{type:'event',event:'state',hostId:this.config.hostId,session:{...s}});}
 private getSession(id:unknown){const s=typeof id==='string'?this.sessions.get(id):null;if(!s)throw new Fault('NOT_FOUND','会话不存在');return s;}
 private getProject(id:unknown){const p=typeof id==='string'?this.projects.get(id):null;if(!p)throw new Fault('NOT_FOUND','项目不存在');return p;}
 private live(s:Session){const r=this.runtimes.get(s.id);if(!r||s.processState!=='running')throw new Fault('NOT_RUNNING','会话进程已退出');return r;}
 private control(client:string,p:any){const s=this.getSession(p.sessionId),r=this.live(s);if(s.runtimeEpoch!==p.runtimeEpoch)throw new Fault('STALE_RUNTIME','运行已变化，请重新连接终端');if(s.controller!==client||s.controlEpoch!==p.controlEpoch||!r.subscribers.has(client))throw new Fault('STALE_CONTROL','操作权已转移，请重新接管');return r;}
 private async dispatch(client:string,method:string,p:any,expires:number):Promise<any>{
  switch(method){
   case 'list':return {host:{id:this.config.hostId,name:this.config.name||hostname(),online:true,platform:process.platform+' '+process.arch,roots:this.config.roots,settings:this.settings(),agents:await(this.agents??=this.detect().catch(()=>[]))},projects:[...this.projects.values()],sessions:[...this.sessions.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))};
   case 'authorize':return {ok:true};
   case 'listDirectories':return listDirectories(p.path,this.config.roots);
   case 'configureHost':{
    if(p.historyDays!==undefined&&(!Number.isInteger(p.historyDays)||p.historyDays<1||p.historyDays>365))throw new Fault('INVALID_SETTINGS','历史保留期须为 1–365 天');
    if(p.maxHistoryBytes!==undefined&&(!Number.isSafeInteger(p.maxHistoryBytes)||p.maxHistoryBytes<16*1024*1024||p.maxHistoryBytes>10*1024*1024*1024))throw new Fault('INVALID_SETTINGS','历史配额须为 16 MiB–10 GiB');
    if(p.preventSleep!==undefined&&typeof p.preventSleep!=='boolean')throw new Fault('INVALID_SETTINGS','防休眠设置无效');
    for(const key of ['historyDays','maxHistoryBytes','preventSleep'] as const)if(p[key]!==undefined)(this.config as any)[key]=p[key];
    this.store.configure(this.settings());this.store.prune();this.updateSleep();return this.settings();
   }
   case 'addProject':{const path=authorizedPath(p.path,this.config.roots);if([...this.projects.values()].some(x=>x.path===path))throw new Fault('DUPLICATE_PROJECT','该目录已添加到项目');const project={id:randomUUID(),hostId:this.config.hostId,name:title(p.name,'项目名称'),path,createdAt:now()};this.projects.set(project.id,project);this.store.saveProject(project);this.emit('event',{type:'event',event:'state',hostId:this.config.hostId,project});return project;}
   case 'renameProject':{const project=this.getProject(p.projectId);project.name=title(p.name,'项目名称');this.store.saveProject(project);this.emit('event',{type:'event',event:'state',hostId:this.config.hostId,project});return project;}
   case 'deleteProject':{const project=this.getProject(p.projectId);if([...this.sessions.values()].some(s=>s.projectId===project.id))throw new Fault('PROJECT_NOT_EMPTY','项目仍有会话，不能删除');this.projects.delete(project.id);this.store.deleteProject(project.id);this.emit('event',{type:'event',event:'state',hostId:this.config.hostId});return {ok:true};}
   case 'createSession':{
    const project=this.getProject(p.projectId);authorizedPath(project.path,this.config.roots);if(p.agent!=='codex'&&p.agent!=='claude')throw new Fault('INVALID_AGENT','请选择 Codex 或 Claude Code');
    if([...this.sessions.values()].some(s=>s.projectId===project.id&&['starting','running'].includes(s.processState))&&p.confirmConflict!==true)throw new Fault('PROJECT_BUSY','同一目录已有运行中的会话，多个 Agent 可能同时修改文件，是否继续？');
    const s:Session={id:randomUUID(),hostId:this.config.hostId,projectId:project.id,title:title(p.title,'会话名称'),agent:p.agent,processState:'starting',activity:'unknown',runtimeEpoch:randomUUID(),nativeSessionId:null,controlEpoch:0,controller:null,cols:100,rows:30,createdAt:now(),updatedAt:now(),archived:false,statusSource:'process'};
    await this.start(s);return {...s};
   }
   case 'renameSession':{const s=this.getSession(p.sessionId);s.title=title(p.title,'会话名称');this.save(s);return s;}
   case 'attach':{
    const s=this.getSession(p.sessionId),r=this.runtimes.get(s.id);
    if(!r){const saved=this.store.snapshot(s.id,s.runtimeEpoch);return {...(saved??{seq:0,data:'',cols:s.cols,rows:s.rows,truncated:this.store.history(s.id,s.runtimeEpoch,undefined,1).truncated}),session:{...s}};}
    return this.enqueue(r,async()=>{const snapshot=this.snapshot(r);r.subscribers.set(client,{expires,ack:r.seq,pending:[],bytes:0});return snapshot;});
   }
   case 'detach':{for(const r of this.runtimes.values())if(!p.sessionId||r.session.id===p.sessionId)this.detach(r,client);return {ok:true};}
   case 'claimControl':{
    const s=this.getSession(p.sessionId),r=this.live(s);if(s.runtimeEpoch!==p.runtimeEpoch)throw new Fault('STALE_RUNTIME','运行已变化，请重新连接终端');if(!r.subscribers.has(client))throw new Fault('NOT_ATTACHED','请先同步终端画面');
    await this.enqueue(r,async()=>{});s.controller=client;s.controlEpoch++;r.inputSeq=0;this.save(s);return {...s};
   }
   case 'input':{
    const r=this.control(client,p);if(typeof p.data!=='string'||Buffer.byteLength(p.data)>16384||!Number.isSafeInteger(p.inputSeq)||p.inputSeq<1)throw new Fault('INVALID_INPUT','输入帧无效或超过 16 KiB');
    if(p.inputSeq<=r.inputSeq)return {inputSeq:p.inputSeq,duplicate:true};
    if(p.inputSeq!==r.inputSeq+1)throw new Fault('INPUT_GAP','输入序号不连续，是否送达无法确认，请检查终端');
    r.pty.write(p.data);r.inputSeq=p.inputSeq;return {inputSeq:p.inputSeq,duplicate:false};
   }
   case 'resize':{const r=this.control(client,p);if(!Number.isInteger(p.cols)||p.cols<20||p.cols>400||!Number.isInteger(p.rows)||p.rows<5||p.rows>200)throw new Fault('INVALID_SIZE','终端尺寸超出允许范围');await this.enqueue(r,async()=>{r.terminal.term.resize(p.cols,p.rows);r.pty.resize(p.cols,p.rows);r.session.cols=p.cols;r.session.rows=p.rows;this.save(r.session);this.broadcastSnapshot(r);});return {...r.session};}
   case 'outputAck':{const s=this.getSession(p.sessionId),r=this.runtimes.get(s.id),sub=r?.subscribers.get(client);if(!r||!sub)return {ok:true};if(p.runtimeEpoch!==s.runtimeEpoch||!Number.isSafeInteger(p.seq)||p.seq>r.seq||p.seq<0)throw new Fault('INVALID_ACK','输出确认无效');if(p.seq<=sub.ack)return {ok:true};sub.ack=p.seq;while(sub.pending[0]?.seq<=p.seq)sub.bytes-=sub.pending.shift()!.bytes;return {ok:true};}
   case 'interrupt':{const r=this.control(client,p);r.pty.write(r.session.agent==='codex'?'\x1b':'\x03');return {ok:true};}
   case 'terminate':{const r=this.control(client,p);if(p.confirm!==true)throw new Fault('CONFIRM_REQUIRED','结束进程需要确认');this.kill(r);return {ok:true};}
   case 'resume':{
    const previous=this.getSession(p.sessionId),s={...previous};if(['starting','running'].includes(s.processState))throw new Fault('ALREADY_RUNNING','当前进程仍在运行，请直接接管');if(!s.nativeSessionId)throw new Fault('NO_NATIVE_SESSION','尚未捕获原生会话 ID，无法精确恢复');
    const old=this.runtimes.get(s.id);if(old){await old.queue;old.terminal.close();this.runtimes.delete(s.id);}s.runtimeEpoch=randomUUID();s.controller=null;s.controlEpoch++;s.processState='starting';s.activity='unknown';s.warning=null;s.archived=false;await this.start(s,true);return {...s};
   }
   case 'archive':{const s=this.getSession(p.sessionId);if(['running','starting'].includes(s.processState))throw new Fault('STILL_RUNNING','请先结束进程，再归档会话');if(typeof p.archived!=='boolean')throw new Fault('INVALID_INPUT','归档状态无效');s.archived=p.archived;this.save(s);return s;}
   case 'history':{const s=this.getSession(p.sessionId);const epoch=p.runtimeEpoch??s.runtimeEpoch;if(typeof epoch!=='string'||epoch.length>100)throw new Fault('INVALID_RUNTIME','运行标识无效');if(p.before!==undefined&&(!Number.isSafeInteger(p.before)||p.before<1))throw new Fault('INVALID_CURSOR','历史游标无效');const limit=p.limit===undefined?100:p.limit;if(!Number.isInteger(limit)||limit<1||limit>200)throw new Fault('INVALID_LIMIT','历史每页最多 200 条');return this.store.history(s.id,epoch,p.before,limit);}
   default:throw new Fault('UNKNOWN_METHOD','不支持该操作');
  }
 }
 private enqueue<T>(r:Runtime,work:()=>Promise<T>):Promise<T>{const task=r.queue.then(work);r.queue=task.catch(()=>{});return task;}
 private snapshot(r:Runtime):Snapshot{let data=r.terminal.snapshot(),truncated=false;if(Buffer.byteLength(data)>1024*1024){data=r.terminal.serializer.serialize({scrollback:100});truncated=true;}return {session:{...r.session},seq:r.seq,data,cols:r.session.cols,rows:r.session.rows,truncated};}
 private broadcastSnapshot(r:Runtime){for(const [clientId,sub]of r.subscribers){if(sub.expires<=Date.now())continue;sub.ack=r.seq;sub.bytes=0;sub.pending=[];this.emit('event',{type:'event',event:'snapshot',hostId:this.config.hostId,sessionId:r.session.id,clientId,...this.snapshot(r)});}}
 private async start(s:Session,resume=false){
  if([...this.runtimes.values()].filter(r=>r.session.processState==='running').length>=(this.config.maxSessions??10))throw new Fault('SESSION_LIMIT','已达到主机并发会话上限');
  const cwd=authorizedPath(this.getProject(s.projectId).path,this.config.roots),hookToken=randomBytes(32).toString('hex');
  try{
   const command=await this.launch({agent:s.agent,cwd,nativeSessionId:resume?s.nativeSessionId??undefined:undefined,sessionId:s.id,runtimeEpoch:s.runtimeEpoch,hookToken,hookSocket:join(this.store.dir,'host.sock'),dataDir:this.store.dir});
   const env:Record<string,string>={};for(const [key,value]of Object.entries(process.env))if(value!==undefined&&!/^(POLY_|RELAY_|OIDC_|DEV_AUTH$|DATABASE_URL$|HOST_CONFIG$)/.test(key))env[key]=value;
   Object.assign(env,command.env,{TERM:'xterm-256color',COLORTERM:'truecolor'});
   const terminal=new TerminalState();terminal.term.resize(s.cols,s.rows);
   let proc:pty.IPty;try{proc=pty.spawn(command.file,command.args,{name:'xterm-256color',cols:s.cols,rows:s.rows,cwd,env});}catch(error){terminal.close();throw error;}
   const r:Runtime={session:s,terminal,pty:proc,queue:Promise.resolve(),queuedBytes:0,seq:0,hookToken,subscribers:new Map(),inputSeq:0,permissions:new Map(),lastHookAt:0,lastSnapshot:0,closing:false};
   this.runtimes.set(s.id,r);this.sessions.set(s.id,s);s.processState='running';s.exitCode=null;this.save(s);
   // Only authoritative headless answers protocol queries. Browser replicas do not send them as input.
   terminal.term.onData(data=>{if(s.processState==='running')proc.write(data);});
   proc.onData(data=>{
    const bytes=Buffer.byteLength(data);r.queuedBytes+=bytes;if(r.queuedBytes>256*1024)proc.pause();
    void this.enqueue(r,async()=>{
     try{const parsed=await terminal.write(data);if(!parsed)return;r.seq++;try{this.store.append(s,r.seq,parsed);if(Date.now()-r.lastSnapshot>2000){this.store.saveSnapshot(this.snapshot(r));r.lastSnapshot=Date.now();}}catch{if(!s.warning){s.warning='终端历史写入失败，请检查可用磁盘；当前实时画面仍可查看';this.save(s);}}
      for(const [clientId,sub]of r.subscribers){if(sub.expires<=Date.now())continue;const bytes=Buffer.byteLength(parsed);sub.bytes+=bytes;sub.pending.push({seq:r.seq,bytes});if(sub.bytes>1024*1024||sub.pending.length>512){this.detach(r,clientId);this.emit('event',{type:'event',event:'resync',hostId:this.config.hostId,sessionId:s.id,clientId,message:'终端输出过快，请重新同步'});continue;}this.emit('event',{type:'event',event:'output',hostId:this.config.hostId,sessionId:s.id,clientId,runtimeEpoch:s.runtimeEpoch,seq:r.seq,data:parsed});}
     }catch(error){s.warning=error instanceof Error?error.message:'终端解析失败';this.save(s);}finally{r.queuedBytes-=bytes;if(r.queuedBytes<64*1024&&s.processState==='running')proc.resume();}
    });
   });
   proc.onExit(({exitCode})=>{void this.enqueue(r,async()=>{s.processState='exited';s.exitCode=exitCode;s.controller=null;s.controlEpoch++;if(s.activity!=='done')s.activity='unknown';this.save(s);try{this.store.saveSnapshot(this.snapshot(r));}catch{s.warning='退出时的终端快照写入失败';this.save(s);}this.emit('event',{type:'event',event:'exit',hostId:this.config.hostId,sessionId:s.id,runtimeEpoch:s.runtimeEpoch,exitCode});this.runtimes.delete(s.id);terminal.close();this.updateSleep();});});
   this.updateSleep();
  }catch(error){s.processState='failed';s.warning=error instanceof Error?error.message:'CLI 启动失败';this.sessions.set(s.id,s);this.save(s);throw new Fault('LAUNCH_FAILED',s.warning);}
 }
 private detach(r:Runtime,client:string){r.subscribers.delete(client);if(r.session.controller===client){r.session.controller=null;r.session.controlEpoch++;r.inputSeq=0;this.save(r.session);}}
 private expire(){if(this.closed)return;if(Date.now()-this.lastPrune>60000){this.lastPrune=Date.now();try{this.store.prune();}catch{/* Persisted write warnings are surfaced on the next output. */}}for(const r of this.runtimes.values())for(const [client,sub]of r.subscribers)if(sub.expires<=Date.now())this.detach(r,client);for(const [client,exp]of this.authorizations)if(exp<=Date.now())this.authorizations.delete(client);}
 private kill(r:Runtime){if(r.closing)return;r.closing=true;try{process.kill(-r.pty.pid,'SIGTERM');}catch{try{r.pty.kill('SIGTERM');}catch{/* Process already exited. */}}const timeout=setTimeout(()=>{try{process.kill(-r.pty.pid,'SIGKILL');}catch{/* The owned process group has already exited. */}},1500);timeout.unref();}
 private updateSleep(){const active=this.config.preventSleep&&process.platform==='darwin'&&[...this.runtimes.values()].some(r=>r.session.processState==='running');if(active&&!this.sleeper){this.sleeper=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});this.sleeper.on('error',()=>{this.sleeper=undefined;});}else if(!active&&this.sleeper){this.sleeper.kill();this.sleeper=undefined;}}
 async hook(token:string,p:any){
  const s=this.getSession(p.sessionId),r=this.live(s),expected=Buffer.from(r.hookToken),actual=Buffer.from(token);
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||p.runtimeEpoch!==s.runtimeEpoch)throw new Fault('UNAUTHORIZED','Hook 授权失效');
  const known=['SessionStart','UserPromptSubmit','PreToolUse','PermissionRequest','PostToolUse','PostToolUseFailure','Stop','SessionEnd','Interrupt','Notification'];
  if(!known.includes(p.event)||typeof p.eventId!=='string'||p.eventId.length>200)throw new Fault('INVALID_HOOK','Hook 事件无效');
  if(p.agentId)return {ok:true};
  const at=Date.parse(p.at);if(!Number.isFinite(at)||at>Date.now()+10000)throw new Fault('INVALID_HOOK','Hook 时间无效');
  const nativeId=p.event==='SessionStart'&&typeof p.nativeSessionId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.nativeSessionId)?p.nativeSessionId:s.nativeSessionId;
  if(!this.store.recordHook(p.eventId,s,p.event,p.at,nativeId)||at<r.lastHookAt)return {ok:true};r.lastHookAt=at;s.nativeSessionId=nativeId;
  if(p.event==='PermissionRequest')r.permissions.set(String(p.toolUseId??('uncorrelated:'+p.eventId)),!p.toolUseId&&typeof p.toolName==='string'?p.toolName:undefined);
  if(['PostToolUse','PostToolUseFailure'].includes(p.event)){if(p.toolUseId)r.permissions.delete(p.toolUseId);if(p.toolName){const matching=[...r.permissions].filter(([,name])=>name===p.toolName);if(matching.length===1)r.permissions.delete(matching[0][0]);}}
  if(p.event==='Stop'||p.event==='SessionEnd')r.permissions.clear();
  s.activity=r.permissions.size?'approval':p.event==='Stop'?'done':['SessionStart','Interrupt'].includes(p.event)?'idle':p.event==='SessionEnd'?'unknown':'working';s.statusSource='hook';this.save(s);return {ok:true};
 }
 async close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);this.sleeper?.kill();for(const r of this.runtimes.values())if(r.session.processState==='running')this.kill(r);await new Promise(resolve=>setTimeout(resolve,this.runtimes.size?1700:0));for(const r of this.runtimes.values()){await r.queue;if(r.session.processState==='running'){try{r.pty.kill('SIGKILL');}catch{}r.session.processState='interrupted';r.session.controller=null;this.store.saveSession(r.session);}try{this.store.saveSnapshot(this.snapshot(r));}catch{}r.terminal.close();}this.store.close();}
}
