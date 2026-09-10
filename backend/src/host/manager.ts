import {EventEmitter} from 'node:events';
import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {jwtVerify} from 'jose';
import * as pty from 'node-pty';
import {join} from 'node:path';
import {hostname,homedir} from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';
import {HostStore} from './store.js';
import type {JournalFaults,OperationHandle,StoredJournalEvent} from './journal.js';
import {TerminalState} from './terminal.js';
import {authorizedPath,title,listDirectories} from './paths.js';
import {Fault,type AgentInfo,type HostConfig,type Project,type Rpc,type Session,type SessionSnapshot} from '../shared/types.js';
import {buildLaunch,detectAgents} from '../adapters/index.js';

type Launch=typeof buildLaunch;
type Subscriber={clientId:string;channelId:string;expires:number;ack:number;pending:{offset:number;bytes:number}[];bytes:number};
type Runtime={session:Session;terminal:TerminalState;pty:pty.IPty;runtimeToken:string;hookToken:string;subscribers:Map<string,Subscriber>;permissions:Map<string,string|undefined>;lastHookAt:number;lastSnapshot:number;parsedOffset:number;queuedBytes:number;closing:boolean};
type Outcome<T>={kind?:string;result?:T;resultFactory?:(event:StoredJournalEvent)=>T;payload?:unknown;runtimeOffset?:number;mutate?:(event:StoredJournalEvent)=>void;afterCommit?:(event:StoredJournalEvent,result:T)=>void;onCommitFailure?:()=>void};
type ManagerDeps={launch?:Launch;detect?:()=>Promise<AgentInfo[]>;faults?:JournalFaults};
const now=()=>new Date().toISOString();
const sessionStream=(id:string)=>`session:${id}`;

export class HostManager extends EventEmitter{
  readonly store:HostStore;
  private projects=new Map<string,Project>();
  private sessions=new Map<string,Session>();
  private runtimes=new Map<string,Runtime>();
  private authorizations=new Map<string,number>();
  private serial:Promise<unknown>=Promise.resolve();
  private pendingRequests=0;
  private timer:NodeJS.Timeout;
  private closed=false;
  private sleeper?:ChildProcess;
  private launch:Launch;
  private detect:()=>Promise<AgentInfo[]>;
  private agents?:Promise<AgentInfo[]>;
  private hostJournalUnavailable=false;

  constructor(readonly config:HostConfig,deps:ManagerDeps={}){
    super();this.launch=deps.launch??buildLaunch;this.detect=deps.detect??detectAgents;
    this.store=new HostStore({dir:config.dataDir??join(homedir(),'.polyhedron'),secret:config.hostToken,hostId:config.hostId,quota:config.maxHistoryBytes,days:config.historyDays,faults:deps.faults});
    Object.assign(this.config,this.store.preferences());this.store.configure(this.settings());
    this.store.projects().forEach(project=>this.projects.set(project.id,project));
    for(const stored of this.store.sessions()){
      const session=this.normalizeSession(stored);const stream=sessionStream(session.id);
      if(this.store.journal.head(stream)===0){const imported=this.store.journal.appendFact({streamId:stream,kind:'legacy_imported',runtimeOffset:1,payload:{source:'legacy_session'},mutate:()=>{}});session.runtimeOffset=imported.offset;session.runtimeEpoch=String(imported.offset)}
      if(['running','starting'].includes(session.processState)){
        const interrupted=this.store.journal.appendFact({streamId:stream,kind:'runtime_interrupted',runtimeOffset:session.runtimeOffset,payload:{reason:'host_restarted'},mutate:()=>{session.processState='interrupted';session.activity='unknown';session.warning='执行服务已重启，原进程已中断，请手动恢复原生会话';session.controller=null;session.controlOffset=null;session.controlEpoch=0;session.headOffset=interruptedOffsetPlaceholder(session,this.store.journal.head(stream)+1);this.store.saveSession(session)}});
        session.headOffset=interrupted.offset;
      }else{session.headOffset=this.store.journal.head(stream);session.controller=null;session.controlOffset=null;session.controlEpoch=0;this.store.saveSession(session)}
      this.sessions.set(session.id,session);
    }
    this.timer=setInterval(()=>this.expire(),1000);this.timer.unref();
  }

  private normalizeSession(session:Session):Session{
    const fallback=Number(session.runtimeEpoch);
    session.runtimeOffset=session.runtimeOffset??(Number.isSafeInteger(fallback)&&fallback>0?fallback:1);
    session.controlOffset=session.controlOffset??null;session.headOffset=session.headOffset??0;session.journalState=session.journalState??'ready';
    return session;
  }
  private enqueue<T>(work:()=>Promise<T>|T):Promise<T>{const task=this.serial.then(work);this.serial=task.catch(()=>{});return task}
  async rpc(request:Rpc):Promise<any>{
    if(this.pendingRequests>=256)throw new Fault('BUSY','主机请求过多，请稍后重试');this.pendingRequests++;
    return this.enqueue(async()=>{
      if(this.closed)throw new Fault('SHUTTING_DOWN','主机服务正在关闭');
      let payload:any;try{({payload}=await jwtVerify(request.grant,new TextEncoder().encode(this.config.hostToken),{algorithms:['HS256'],subject:this.config.accountId}))}catch{throw new Fault('UNAUTHORIZED','主机授权已失效')}
      if(payload.hostId!==this.config.hostId||payload.clientId!==request.clientId||payload.scope!=='host'||payload.method!==request.method||payload.sessionId!==request.params?.sessionId||typeof payload.exp!=='number'||payload.exp*1000>Date.now()+31000)throw new Fault('UNAUTHORIZED','主机授权与本次操作不匹配');
      const channelId=request.channelId??request.clientId;if(!channelId||channelId.length>200)throw new Fault('UNAUTHORIZED','控制通道无效');
      const expires=payload.exp*1000;this.authorizations.set(channelId,expires);for(const runtime of this.runtimes.values()){const subscriber=runtime.subscribers.get(channelId);if(subscriber)subscriber.expires=expires}
      return this.dispatch(request.clientId,channelId,request.requestId,request.method,request.params??{},expires);
    }).finally(()=>{this.pendingRequests--})
  }

  private settings(){return {preventSleep:this.config.preventSleep??false,historyDays:this.config.historyDays??30,maxHistoryBytes:this.config.maxHistoryBytes??128*1024*1024}}
  private getSession(id:unknown){const session=typeof id==='string'?this.sessions.get(id):null;if(!session)throw new Fault('NOT_FOUND','会话不存在');return session}
  private getProject(id:unknown){const project=typeof id==='string'?this.projects.get(id):null;if(!project)throw new Fault('NOT_FOUND','项目不存在');return project}
  private live(session:Session){const runtime=this.runtimes.get(session.id);if(!runtime||session.processState!=='running')throw new Fault('NOT_RUNNING','会话进程已退出');return runtime}
  private control(channelId:string,p:any){const session=this.getSession(p.sessionId);if(session.journalState!=='ready')throw new Fault('JOURNAL_UNAVAILABLE','本地会话记录不可用，远程操作已暂停');const runtime=this.live(session);if(session.runtimeOffset!==p.runtimeOffset)throw new Fault('RUNTIME_CHANGED','运行已变化，请重新连接终端');if(session.controller!==channelId||session.controlOffset!==p.controlOffset||!runtime.subscribers.has(channelId))throw new Fault('STALE_CONTROL','操作权已转移，请重新接管');return runtime}
  private operationId(requestId:string,p:any){const id=typeof p.operationId==='string'?p.operationId:requestId;if(!id||id.length>200)throw new Fault('INVALID_OPERATION','操作标识无效');return id}
  private auditPayload(kind:string,p:any){if(kind==='input'){const data=String(p.data??'');return {bytes:Buffer.byteLength(data),digest:this.store.cipher.digest(data),runtimeOffset:p.runtimeOffset,controlOffset:p.controlOffset}}const copy:{[key:string]:unknown}={};for(const [key,value]of Object.entries(p))if(key!=='operationId'&&key!=='channelId')copy[key]=value;return copy}
  private emitState(session?:Session,project?:Project){this.emit('event',{type:'event',event:'state',hostId:this.config.hostId,...(session?{session:{...session}}:{}),...(project?{project:{...project}}:{})})}
  private wireEvent(event:StoredJournalEvent,session:Session,clientId?:string){const payload=event.payload as any;return {type:'event',event:'journal',kind:event.kind,hostId:this.config.hostId,sessionId:session.id,...(clientId?{clientId}:{}),offset:event.offset,runtimeOffset:event.runtimeOffset||session.runtimeOffset||1,...(event.kind==='pty_output'?{data:String(payload?.data??'')}:{session:{...session}})}}
  private broadcast(runtime:Runtime,event:StoredJournalEvent){for(const subscriber of runtime.subscribers.values()){if(subscriber.expires<=Date.now())continue;const message=this.wireEvent(event,runtime.session,subscriber.clientId),bytes=Buffer.byteLength(JSON.stringify(message));subscriber.bytes+=bytes;subscriber.pending.push({offset:event.offset,bytes});if(subscriber.bytes>1024*1024||subscriber.pending.length>512){this.detachRuntime(runtime,subscriber.channelId,true);this.emit('event',{type:'event',event:'resync',hostId:this.config.hostId,sessionId:runtime.session.id,clientId:subscriber.clientId,message:'终端输出过快，请重新同步'});continue}this.emit('event',message)}}
  private broadcastSession(session:Session,event:StoredJournalEvent){const runtime=this.runtimes.get(session.id);if(runtime)this.broadcast(runtime,event)}
  private degrade(session:Session|undefined,error:unknown){
    const message=error instanceof Error?error.message:'本地 journal 写入失败';if(!session){this.hostJournalUnavailable=true;return}
    session.journalState='unavailable';session.warning=`本地会话记录不可用，远程操作已暂停：${message}`;const runtime=this.runtimes.get(session.id);try{runtime?.pty.pause()}catch{}
    try{const event=this.store.journal.appendFact({streamId:sessionStream(session.id),kind:'journal_degraded',runtimeOffset:session.runtimeOffset,payload:{reason:message},mutate:(_db,item)=>{session.headOffset=item.offset;this.store.saveSession(session)}});session.headOffset=event.offset}catch{}
    this.emitState(session);
  }
  private duplicate<T>(record:any):T{if(record.status==='applied')return record.result as T;if(record.status==='failed')throw new Fault(record.error?.code??'OPERATION_FAILED',record.error?.message??'操作失败');if(record.status==='indeterminate')throw new Fault('OPERATION_INDETERMINATE','操作结果未知，不会自动重放');throw new Fault('BUSY','相同操作仍在处理中')}
  private async recorded<T>(input:{clientId:string;channelId:string;requestId:string;kind:string;p:any;session?:Session;streamId?:string;execute:()=>Promise<Outcome<T>>|Outcome<T>;onFailure?:(error:unknown,event:StoredJournalEvent)=>void}):Promise<T>{
    const streamId=input.streamId??(input.session?sessionStream(input.session.id):`host:${this.config.hostId}`),operationId=this.operationId(input.requestId,input.p),actor=input.channelId;
    if((this.hostJournalUnavailable&&!input.session)||(input.session&&input.session.journalState!=='ready'))throw new Fault('JOURNAL_UNAVAILABLE','本地会话记录不可用，远程操作已暂停');
    let begun;try{begun=this.store.journal.begin({streamId,operationId,actor,kind:input.kind,runtimeOffset:input.session?.runtimeOffset,payload:this.auditPayload(input.kind,input.p)})}catch(error){this.degrade(input.session,error);throw new Fault('JOURNAL_UNAVAILABLE','本地操作记录写入失败，操作未执行')}
    if(begun.duplicate)return this.duplicate<T>(begun.duplicate);
    const requested=this.store.journal.eventsAfter(streamId,begun.handle!.requestOffset-1,1)[0];if(input.session){input.session.headOffset=requested.offset;this.broadcastSession(input.session,requested)}
    let outcome:Outcome<T>;
    try{outcome=await input.execute()}catch(error){
      const appError=error instanceof Fault?{code:error.code,message:error.message}:{code:'OPERATION_FAILED',message:error instanceof Error?error.message:'操作失败'};
      try{const event=this.store.journal.complete(begun.handle!,{kind:'operation_failed',status:'failed',error:appError,runtimeOffset:input.session?.runtimeOffset,mutate:(_db,item)=>{if(input.session){input.session.headOffset=item.offset;input.onFailure?.(error,item);this.store.saveSession(input.session)}}});if(input.session){this.broadcastSession(input.session,event);this.emitState(input.session)}}catch(commitError){this.degrade(input.session,commitError);throw new Fault('JOURNAL_UNAVAILABLE','操作失败结果无法持久化')}
      throw error;
    }
    let event:StoredJournalEvent;
    try{event=this.store.journal.complete(begun.handle!,{kind:outcome.kind??`${input.kind}_applied`,payload:outcome.payload,result:outcome.result,resultFactory:outcome.resultFactory,runtimeOffset:outcome.runtimeOffset??input.session?.runtimeOffset,mutate:(_db,item)=>{outcome.mutate?.(item);if(input.session){input.session.headOffset=item.offset;this.store.saveSession(input.session)}}})}catch(error){outcome.onCommitFailure?.();this.degrade(input.session,error);const fault=new Fault('JOURNAL_UNAVAILABLE','操作已提交给本地进程，但结果记录失败；执行结果未知且不会自动重放');(fault as Error&{cause?:unknown}).cause=error;throw fault}
    const result=outcome.resultFactory?outcome.resultFactory(event):outcome.result as T;if(input.session){this.broadcastSession(input.session,event);this.emitState(input.session)}outcome.afterCommit?.(event,result);return result;
  }

  private async dispatch(clientId:string,channelId:string,requestId:string,method:string,p:any,expires:number):Promise<any>{
    if(method==='authorize')return {ok:true};
    if(method==='eventAck'){const session=this.getSession(p.sessionId),runtime=this.runtimes.get(session.id),subscriber=runtime?.subscribers.get(channelId);if(!runtime||!subscriber)return {ok:true};if(!Number.isSafeInteger(p.appliedOffset)||p.appliedOffset<0||p.appliedOffset>session.headOffset!)throw new Fault('INVALID_ACK','事件确认无效');if(p.appliedOffset<=subscriber.ack)return {ok:true};subscriber.ack=p.appliedOffset;while(subscriber.pending[0]?.offset<=p.appliedOffset)subscriber.bytes-=subscriber.pending.shift()!.bytes;return {ok:true}}
    switch(method){
      case 'list':return this.recorded({clientId,channelId,requestId,kind:'list',p,execute:async()=>({kind:'history_read_served',result:{host:{id:this.config.hostId,name:this.config.name||hostname(),online:true,platform:`${process.platform} ${process.arch}`,roots:this.config.roots,settings:this.settings(),agents:await(this.agents??=this.detect().catch(()=>[]))},projects:[...this.projects.values()],sessions:[...this.sessions.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}})});
      case 'listDirectories':{const result=listDirectories(p.path,this.config.roots);return this.recorded({clientId,channelId,requestId,kind:'list_directories',p,execute:()=>({result})})}
      case 'configureHost':{
        if(p.historyDays!==undefined&&(!Number.isInteger(p.historyDays)||p.historyDays<1||p.historyDays>365))throw new Fault('INVALID_SETTINGS','历史保留期须为 1–365 天');if(p.maxHistoryBytes!==undefined&&(!Number.isSafeInteger(p.maxHistoryBytes)||p.maxHistoryBytes<16*1024*1024||p.maxHistoryBytes>10*1024*1024*1024))throw new Fault('INVALID_SETTINGS','历史配额须为 16 MiB–10 GiB');if(p.preventSleep!==undefined&&typeof p.preventSleep!=='boolean')throw new Fault('INVALID_SETTINGS','防休眠设置无效');
        const settings={...this.settings(),...Object.fromEntries(['historyDays','maxHistoryBytes','preventSleep'].filter(key=>p[key]!==undefined).map(key=>[key,p[key]]))};return this.recorded({clientId,channelId,requestId,kind:'configure_host',p,execute:()=>({result:settings,mutate:()=>this.store.configure(settings),afterCommit:()=>{Object.assign(this.config,settings);this.updateSleep()}})})
      }
      case 'addProject':{
        const path=authorizedPath(p.path,this.config.roots);if([...this.projects.values()].some(project=>project.path===path))throw new Fault('DUPLICATE_PROJECT','该目录已添加到项目');const project:Project={id:randomUUID(),hostId:this.config.hostId,name:title(p.name,'项目名称'),path,createdAt:now()};
        return this.recorded({clientId,channelId,requestId,kind:'add_project',p,execute:()=>({result:project,mutate:()=>this.store.saveProject(project),afterCommit:()=>{this.projects.set(project.id,project);this.emitState(undefined,project)}})})
      }
      case 'renameProject':{const previous=this.getProject(p.projectId),project={...previous,name:title(p.name,'项目名称')};return this.recorded({clientId,channelId,requestId,kind:'rename_project',p,execute:()=>({result:project,mutate:()=>this.store.saveProject(project),afterCommit:()=>{this.projects.set(project.id,project);this.emitState(undefined,project)}})})}
      case 'deleteProject':{const project=this.getProject(p.projectId);if([...this.sessions.values()].some(session=>session.projectId===project.id))throw new Fault('PROJECT_NOT_EMPTY','项目仍有会话，不能删除');return this.recorded({clientId,channelId,requestId,kind:'delete_project',p,execute:()=>({result:{ok:true},mutate:()=>this.store.deleteProject(project.id),afterCommit:()=>{this.projects.delete(project.id);this.emitState()}})})}
      case 'createSession':return this.createSession(clientId,channelId,requestId,p,false);
      case 'resume':return this.createSession(clientId,channelId,requestId,p,true);
      case 'renameSession':{const session=this.getSession(p.sessionId),nextTitle=title(p.title,'会话名称');return this.recorded({clientId,channelId,requestId,kind:'rename_session',p,session,execute:()=>({resultFactory:()=>({...session}),mutate:()=>{session.title=nextTitle}})})}
      case 'attach':{
        const session=this.getSession(p.sessionId);if(session.journalState!=='ready')throw new Fault('JOURNAL_UNAVAILABLE','本地会话记录不可用，无法读取历史');const runtime=this.runtimes.get(session.id);let base=this.makeSnapshot(session,runtime);return this.recorded({clientId,channelId,requestId,kind:'client_attach',p,session,execute:()=>({kind:'client_attached',resultFactory:event=>{const events=this.wireTail(session,base.baseOffset,event.offset,clientId);return {...base,headOffset:event.offset,events}},afterCommit:event=>{if(runtime)runtime.subscribers.set(channelId,{clientId,channelId,expires,ack:event.offset,pending:[],bytes:0})}})})
      }
      case 'detach':{
        const targets=p.sessionId?[this.getSession(p.sessionId)]:[...this.sessions.values()];for(const session of targets){const runtime=this.runtimes.get(session.id);if(!runtime?.subscribers.has(channelId))continue;await this.recorded({clientId,channelId,requestId:targets.length===1?requestId:`${requestId}:${session.id}`,kind:'client_detach',p:{...p,operationId:targets.length===1?this.operationId(requestId,p):`${this.operationId(requestId,p)}:${session.id}`},session,execute:()=>({kind:session.controller===channelId?'control_released':'client_detached',result:{ok:true},mutate:()=>{if(session.controller===channelId){session.controller=null;session.controlOffset=null;session.controlEpoch=0}},afterCommit:()=>this.detachRuntime(runtime,channelId,false)})})}return {ok:true}
      }
      case 'claimControl':{const session=this.getSession(p.sessionId);return this.recorded({clientId,channelId,requestId,kind:'control',p,session,execute:()=>{const runtime=this.live(session);if(session.runtimeOffset!==p.runtimeOffset)throw new Fault('RUNTIME_CHANGED','运行已变化，请重新连接终端');if(!runtime.subscribers.has(channelId))throw new Fault('NOT_ATTACHED','请先同步终端画面');return {kind:'control_acquired',resultFactory:()=>({...session}),mutate:event=>{session.controller=channelId;session.controlOffset=event.offset;session.controlEpoch=event.offset}}}})}
      case 'input':{const session=this.getSession(p.sessionId);if(typeof p.data!=='string'||Buffer.byteLength(p.data)>16384)throw new Fault('INVALID_INPUT','输入帧无效或超过 16 KiB');return this.recorded({clientId,channelId,requestId,kind:'input',p,session,execute:()=>{const runtime=this.control(channelId,p);runtime.pty.write(p.data);return {result:{operationId:this.operationId(requestId,p),accepted:true},runtimeOffset:runtime.session.runtimeOffset}},onFailure:()=>{}})}
      case 'resize':{const session=this.getSession(p.sessionId);if(!Number.isInteger(p.cols)||p.cols<20||p.cols>400||!Number.isInteger(p.rows)||p.rows<5||p.rows>200)throw new Fault('INVALID_SIZE','终端尺寸超出允许范围');return this.recorded({clientId,channelId,requestId,kind:'resize',p,session,execute:async()=>{const runtime=this.control(channelId,p);runtime.terminal.term.resize(p.cols,p.rows);runtime.pty.resize(p.cols,p.rows);return {resultFactory:()=>({...runtime.session}),mutate:()=>{runtime.session.cols=p.cols;runtime.session.rows=p.rows},afterCommit:()=>this.broadcastSnapshot(runtime)}}})}
      case 'interrupt':{const session=this.getSession(p.sessionId);return this.recorded({clientId,channelId,requestId,kind:'interrupt',p,session,execute:()=>{const runtime=this.control(channelId,p);runtime.pty.write(runtime.session.agent==='codex'?'\x1b':'\x03');return {result:{ok:true}}}})}
      case 'terminate':{const session=this.getSession(p.sessionId);if(p.confirm!==true)throw new Fault('CONFIRM_REQUIRED','结束进程需要确认');return this.recorded({clientId,channelId,requestId,kind:'terminate',p,session,execute:()=>{const runtime=this.control(channelId,p);this.kill(runtime);return {result:{ok:true}}}})}
      case 'archive':{const session=this.getSession(p.sessionId);if(['running','starting'].includes(session.processState))throw new Fault('STILL_RUNNING','请先结束进程，再归档会话');if(typeof p.archived!=='boolean')throw new Fault('INVALID_INPUT','归档状态无效');return this.recorded({clientId,channelId,requestId,kind:'archive',p,session,execute:()=>({resultFactory:()=>({...session}),mutate:()=>{session.archived=p.archived}})})}
      case 'history':{const session=this.getSession(p.sessionId);if(session.journalState!=='ready')throw new Fault('JOURNAL_UNAVAILABLE','本地会话记录不可用，无法读取历史');const runtimeOffset=p.runtimeOffset??session.runtimeOffset;if(!Number.isSafeInteger(runtimeOffset)||runtimeOffset<1)throw new Fault('INVALID_RUNTIME','运行标识无效');if(p.before!==undefined&&(!Number.isSafeInteger(p.before)||p.before<1))throw new Fault('INVALID_CURSOR','历史游标无效');const limit=p.limit===undefined?100:p.limit;if(!Number.isInteger(limit)||limit<1||limit>200)throw new Fault('INVALID_LIMIT','历史每页最多 200 条');return this.recorded({clientId,channelId,requestId,kind:'history_read',p,session,execute:()=>({kind:'history_read_served',result:this.store.history(session.id,String(runtimeOffset),p.before,limit)})})}
      default:throw new Fault('UNKNOWN_METHOD','不支持该操作');
    }
  }

  private async createSession(clientId:string,channelId:string,requestId:string,p:any,resume:boolean){
    let session:Session,project:Project;
    if(resume){const previous=this.getSession(p.sessionId);if(['starting','running'].includes(previous.processState))throw new Fault('ALREADY_RUNNING','当前进程仍在运行，请直接接管');if(!previous.nativeSessionId)throw new Fault('NO_NATIVE_SESSION','尚未捕获原生会话 ID，无法精确恢复');session={...previous,processState:'starting',activity:'unknown',controller:null,controlOffset:null,controlEpoch:0,journalState:'ready',warning:null,archived:false};project=this.getProject(session.projectId)}
    else{project=this.getProject(p.projectId);authorizedPath(project.path,this.config.roots);if(p.agent!=='codex'&&p.agent!=='claude')throw new Fault('INVALID_AGENT','请选择 Codex 或 Claude Code');if([...this.sessions.values()].some(item=>item.projectId===project.id&&['starting','running'].includes(item.processState))&&p.confirmConflict!==true)throw new Fault('PROJECT_BUSY','同一目录已有运行中的会话，多个 Agent 可能同时修改文件，是否继续？');session={id:randomUUID(),hostId:this.config.hostId,projectId:project.id,title:title(p.title,'会话名称'),agent:p.agent,processState:'starting',activity:'unknown',runtimeEpoch:'',nativeSessionId:null,controlEpoch:0,controller:null,cols:100,rows:30,createdAt:now(),updatedAt:now(),archived:false,statusSource:'process',runtimeOffset:0,controlOffset:null,headOffset:0,journalState:'ready'}}
    if([...this.runtimes.values()].filter(runtime=>runtime.session.processState==='running').length>=(this.config.maxSessions??10))throw new Fault('SESSION_LIMIT','已达到主机并发会话上限');
    return this.recorded({clientId,channelId,requestId,kind:resume?'runtime_resume':'session_create',p,session,execute:async()=>{
      let runtime:Runtime;try{runtime=await this.spawnRuntime(session,project,resume)}catch(error){throw new Fault('LAUNCH_FAILED',error instanceof Error?error.message:'CLI 启动失败')}
      return {kind:'runtime_started',runtimeOffset:undefined,resultFactory:()=>({...session}),mutate:event=>{session.runtimeOffset=event.offset;session.runtimeEpoch=String(event.offset);session.processState='running';session.exitCode=null;session.warning=null;session.journalState='ready';runtime.parsedOffset=event.offset},afterCommit:()=>{runtime.session=session;this.sessions.set(session.id,session);this.activateRuntime(runtime);this.emitState(session);this.updateSleep()},onCommitFailure:()=>{session.journalState='unavailable';runtime.session=session;try{runtime.pty.pause()}catch{}this.runtimes.set(session.id,runtime)}}
    },onFailure:(error)=>{session.processState='failed';session.warning=error instanceof Error?error.message:'CLI 启动失败';session.journalState='ready';this.sessions.set(session.id,session)}})
  }

  private async spawnRuntime(session:Session,project:Project,resume:boolean):Promise<Runtime>{
    const cwd=authorizedPath(project.path,this.config.roots),hookToken=randomBytes(32).toString('hex'),runtimeToken=randomUUID();
    const command=await this.launch({agent:session.agent,cwd,nativeSessionId:resume?session.nativeSessionId??undefined:undefined,sessionId:session.id,runtimeToken,hookToken,hookSocket:join(this.store.dir,'host.sock'),dataDir:this.store.dir});
    const env:Record<string,string>={};for(const [key,value]of Object.entries(process.env))if(value!==undefined&&!/^(POLY_|RELAY_|OIDC_|DEV_AUTH$|DATABASE_URL$|HOST_CONFIG$)/.test(key))env[key]=value;Object.assign(env,command.env,{TERM:'xterm-256color',COLORTERM:'truecolor'});
    const terminal=new TerminalState();terminal.term.resize(session.cols,session.rows);try{const proc=pty.spawn(command.file,command.args,{name:'xterm-256color',cols:session.cols,rows:session.rows,cwd,env});return {session,terminal,pty:proc,runtimeToken,hookToken,subscribers:new Map(),permissions:new Map(),lastHookAt:0,lastSnapshot:0,parsedOffset:session.headOffset??0,queuedBytes:0,closing:false}}catch(error){terminal.close();throw error}
  }
  private activateRuntime(runtime:Runtime){
    const {session,pty:proc,terminal}=runtime;this.runtimes.set(session.id,runtime);
    terminal.term.onData(data=>{void this.enqueue(()=>{if(session.processState!=='running'||session.journalState!=='ready')return;try{const event=this.store.journal.appendFact({streamId:sessionStream(session.id),kind:'terminal_protocol_response',runtimeOffset:session.runtimeOffset,payload:{bytes:Buffer.byteLength(data),digest:this.store.cipher.digest(data)},mutate:(_db,item)=>{session.headOffset=item.offset;this.store.saveSession(session)}});this.broadcast(runtime,event);proc.write(data)}catch(error){this.degrade(session,error)}})});
    proc.onData(data=>{const bytes=Buffer.byteLength(data);runtime.queuedBytes+=bytes;if(runtime.queuedBytes>256*1024)proc.pause();void this.enqueue(()=>this.handleOutput(runtime,data,bytes))});
    proc.onExit(({exitCode})=>{void this.enqueue(()=>this.handleExit(runtime,exitCode))});
  }
  private async handleOutput(runtime:Runtime,data:string,bytes:number){
    const session=runtime.session;if(session.processState!=='running'||session.journalState!=='ready'){runtime.queuedBytes-=bytes;return}
    let event:StoredJournalEvent;try{event=this.store.journal.appendFact({streamId:sessionStream(session.id),kind:'pty_output',runtimeOffset:session.runtimeOffset,payload:{data,at:now()},mutate:(_db,item)=>{session.headOffset=item.offset;this.store.saveSession(session)}})}catch(error){runtime.queuedBytes-=bytes;this.degrade(session,error);return}
    try{await runtime.terminal.write(data);if(runtime.terminal.checkpointReady())runtime.parsedOffset=event.offset;this.broadcast(runtime,event);if(runtime.terminal.checkpointReady()&&Date.now()-runtime.lastSnapshot>2000){this.store.saveOffsetSnapshot(this.makeSnapshot(session,runtime));runtime.lastSnapshot=Date.now()}}catch(error){this.degrade(session,error);return}finally{runtime.queuedBytes-=bytes;if(runtime.queuedBytes<64*1024&&session.processState==='running'&&session.journalState==='ready')procResume(runtime)}
  }
  private handleExit(runtime:Runtime,exitCode:number){const session=runtime.session;if(this.runtimes.get(session.id)!==runtime)return;try{const event=this.store.journal.appendFact({streamId:sessionStream(session.id),kind:'runtime_exited',runtimeOffset:session.runtimeOffset,payload:{exitCode},mutate:(_db,item)=>{session.headOffset=item.offset;session.processState='exited';session.exitCode=exitCode;session.controller=null;session.controlOffset=null;session.controlEpoch=0;if(session.activity!=='done')session.activity='unknown';this.store.saveSession(session)}});this.broadcast(runtime,event);if(runtime.terminal.checkpointReady())this.store.saveOffsetSnapshot(this.makeSnapshot(session,runtime));this.emitState(session);this.emit('event',{type:'event',event:'exit',hostId:this.config.hostId,sessionId:session.id,runtimeOffset:session.runtimeOffset,offset:event.offset,exitCode})}catch(error){this.degrade(session,error)}finally{this.runtimes.delete(session.id);runtime.terminal.close();this.updateSleep()}}
  private makeSnapshot(session:Session,runtime?:Runtime):SessionSnapshot{
    if(runtime){let data=runtime.terminal.snapshot(),truncated=false;if(Buffer.byteLength(data)>1024*1024){data=runtime.terminal.serializer.serialize({scrollback:100});truncated=true}return {session:{...session},baseOffset:runtime.parsedOffset,headOffset:session.headOffset??runtime.parsedOffset,data,cols:session.cols,rows:session.rows,truncated}}
    const saved=this.store.offsetSnapshot(session.id,session.runtimeOffset??1);return saved??{session:{...session},baseOffset:0,headOffset:session.headOffset??0,data:'',cols:session.cols,rows:session.rows,truncated:false}
  }
  private wireTail(session:Session,after:number,through:number,clientId:string){return this.store.journal.eventsAfter(sessionStream(session.id),after,Math.max(0,through-after)).filter(event=>event.offset<=through).map(event=>this.wireEvent(event,session,clientId))}
  private broadcastSnapshot(runtime:Runtime){const snapshot=this.makeSnapshot(runtime.session,runtime);for(const subscriber of runtime.subscribers.values()){subscriber.ack=snapshot.headOffset;subscriber.bytes=0;subscriber.pending=[];this.emit('event',{type:'event',event:'snapshot',hostId:this.config.hostId,sessionId:runtime.session.id,clientId:subscriber.clientId,...snapshot,events:this.wireTail(runtime.session,snapshot.baseOffset,snapshot.headOffset,subscriber.clientId)})}}
  private detachRuntime(runtime:Runtime,channelId:string,updateControl:boolean){runtime.subscribers.delete(channelId);if(updateControl&&runtime.session.controller===channelId){runtime.session.controller=null;runtime.session.controlOffset=null;runtime.session.controlEpoch=0}}
  private expire(){if(this.closed)return;for(const runtime of this.runtimes.values())for(const [channelId,subscriber]of runtime.subscribers)if(subscriber.expires<=Date.now()){void this.enqueue(async()=>{if(!runtime.subscribers.has(channelId))return;try{await this.recorded({clientId:subscriber.clientId,channelId,requestId:`expire:${randomUUID()}`,kind:'client_expire',p:{operationId:randomUUID(),sessionId:runtime.session.id},session:runtime.session,execute:()=>({kind:runtime.session.controller===channelId?'control_released':'client_detached',result:{ok:true},mutate:()=>{if(runtime.session.controller===channelId){runtime.session.controller=null;runtime.session.controlOffset=null;runtime.session.controlEpoch=0}},afterCommit:()=>this.detachRuntime(runtime,channelId,false)})})}catch{this.detachRuntime(runtime,channelId,true)}})}for(const [channelId,expiry]of this.authorizations)if(expiry<=Date.now())this.authorizations.delete(channelId)}
  private kill(runtime:Runtime){if(runtime.closing)return;runtime.closing=true;try{process.kill(-runtime.pty.pid,'SIGTERM')}catch{try{runtime.pty.kill('SIGTERM')}catch{}}const timeout=setTimeout(()=>{try{process.kill(-runtime.pty.pid,'SIGKILL')}catch{}},1500);timeout.unref()}
  private updateSleep(){const active=this.config.preventSleep&&process.platform==='darwin'&&[...this.runtimes.values()].some(runtime=>runtime.session.processState==='running');if(active&&!this.sleeper){this.sleeper=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});this.sleeper.on('error',()=>{this.sleeper=undefined})}else if(!active&&this.sleeper){this.sleeper.kill();this.sleeper=undefined}}

  async hook(token:string,p:any){return this.enqueue(async()=>{
    const session=this.getSession(p.sessionId),runtime=this.live(session),expected=Buffer.from(runtime.hookToken),actual=Buffer.from(token);if(actual.length!==expected.length||!timingSafeEqual(actual,expected)||p.runtimeToken!==runtime.runtimeToken)throw new Fault('UNAUTHORIZED','Hook 授权失效');
    const known=['SessionStart','UserPromptSubmit','PreToolUse','PermissionRequest','PostToolUse','PostToolUseFailure','Stop','SessionEnd','Interrupt','Notification'];if(!known.includes(p.event)||typeof p.eventId!=='string'||p.eventId.length>200)throw new Fault('INVALID_HOOK','Hook 事件无效');if(p.agentId)return {ok:true};const at=Date.parse(p.at);if(!Number.isFinite(at)||at>Date.now()+10000)throw new Fault('INVALID_HOOK','Hook 时间无效');if(this.store.hasHook(p.eventId)||at<runtime.lastHookAt)return {ok:true};
    const nativeId=p.event==='SessionStart'&&typeof p.nativeSessionId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.nativeSessionId)?p.nativeSessionId:session.nativeSessionId,nextPermissions=new Map(runtime.permissions);
    if(p.event==='PermissionRequest')nextPermissions.set(String(p.toolUseId??`uncorrelated:${p.eventId}`),!p.toolUseId&&typeof p.toolName==='string'?p.toolName:undefined);if(['PostToolUse','PostToolUseFailure'].includes(p.event)){if(p.toolUseId)nextPermissions.delete(p.toolUseId);if(p.toolName){const matching=[...nextPermissions].filter(([,name])=>name===p.toolName);if(matching.length===1)nextPermissions.delete(matching[0][0])}}if(p.event==='Stop'||p.event==='SessionEnd')nextPermissions.clear();
    const activity=nextPermissions.size?'approval':p.event==='Stop'?'done':['SessionStart','Interrupt'].includes(p.event)?'idle':p.event==='SessionEnd'?'unknown':'working';
    try{const event=this.store.journal.appendFact({streamId:sessionStream(session.id),kind:'agent_state_changed',operationId:p.eventId,actor:'hook',runtimeOffset:session.runtimeOffset,at:p.at,payload:{event:p.event,activity,nativeSessionBound:!!nativeId,toolUseId:p.toolUseId??null,toolName:p.toolName??null},mutate:(_db,item)=>{session.headOffset=item.offset;session.nativeSessionId=nativeId;session.activity=activity;session.statusSource='hook';if(!this.store.recordHook(p.eventId,session,p.event,p.at,nativeId))throw new Fault('DUPLICATE_HOOK','Hook event already exists');this.store.saveSession(session)}});runtime.permissions=nextPermissions;runtime.lastHookAt=at;this.broadcast(runtime,event);this.emitState(session);return {ok:true}}catch(error){this.degrade(session,error);throw new Fault('JOURNAL_UNAVAILABLE','Hook 状态无法持久化')}
  })}
  async close(){if(this.closed)return;this.closed=true;clearInterval(this.timer);this.sleeper?.kill();for(const runtime of this.runtimes.values())if(runtime.session.processState==='running')this.kill(runtime);await new Promise(resolve=>setTimeout(resolve,this.runtimes.size?1700:0));for(const runtime of this.runtimes.values()){try{runtime.pty.kill('SIGKILL')}catch{}runtime.terminal.close()}this.runtimes.clear();await this.serial.catch(()=>{});this.store.close()}
}

function procResume(runtime:Runtime){try{runtime.pty.resume()}catch{}}
function interruptedOffsetPlaceholder(session:Session,offset:number){session.headOffset=offset;return offset}
