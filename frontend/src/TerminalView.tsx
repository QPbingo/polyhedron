import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {SearchAddon} from '@xterm/addon-search';
import {WebglAddon} from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {RpcClient,type Connection} from './api';
import {OutputCursor,inputAllowed} from './protocol';
import {onTerminalUserInput} from './terminalInput';
import {highlightTerminalInputs} from './terminalHighlights';
import {active,type Session,type Snapshot,type Output} from './types';
export interface TerminalActions {claim:()=>Promise<void>;interrupt:()=>Promise<void>;terminate:()=>Promise<void>;find:(text:string,previous?:boolean)=>boolean;copy:()=>Promise<void>}
interface Props {session:Session;rpc:RpcClient;connection:Connection;hostOnline:boolean;fontSize:number;palette:string;onSession:(s:Session)=>void;onError:(message:string)=>void}
export const TerminalView=forwardRef<TerminalActions,Props>(function TerminalView(props,ref){
 const container=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),fit=useRef<FitAddon|null>(null),search=useRef<SearchAddon|null>(null);
 const session=useRef(props.session),current=useRef(props),snapshotReady=useRef(false),inputSupported=useRef(true),resized=useRef(false),inputSeq=useRef(0),writeChain=useRef<Promise<void>>(Promise.resolve()),resizeVersion=useRef(0);
 const [hint,setHint]=useState('正在读取终端快照…');current.current=props;
 const permitted=()=>inputSupported.current&&inputAllowed({online:current.current.connection==='online'&&current.current.hostOnline,snapshot:snapshotReady.current,resized:resized.current,controller:session.current.controller,clientId:props.rpc.clientId,running:active(session.current)});
 const syncGate=()=>{const ok=permitted();if(terminal.current)terminal.current.options.disableStdin=!ok;setHint(!inputSupported.current?'终端输入不可用 · 需要匹配的 xterm 版本':current.current.connection!=='online'||!current.current.hostOnline?'连接已断开 · 输入已暂停':!snapshotReady.current?'正在读取终端快照…':ok?'已接管 · 可直接在终端输入':active(session.current)?'只读 · 在会话详情中接管':'进程已结束 · 可查看历史或恢复会话')};
 useEffect(()=>{if(session.current.controlEpoch!==props.session.controlEpoch||session.current.controller!==props.session.controller){resized.current=false;resizeVersion.current++}session.current=props.session;syncGate()},[props.session,props.connection,props.hostOnline]);
 const resize=async()=>{
  if(!terminal.current||!fit.current||!snapshotReady.current||session.current.controller!==props.rpc.clientId||current.current.connection!=='online')return;
  const dimensions=fit.current.proposeDimensions();if(resized.current&&dimensions&&session.current.cols===dimensions.cols&&session.current.rows===dimensions.rows&&terminal.current.cols===dimensions.cols&&terminal.current.rows===dimensions.rows)return;
  const version=++resizeVersion.current;resized.current=false;syncGate();fit.current.fit();
  const s=session.current;const result=await props.rpc.request<Session>(s.hostId,'resize',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,controlEpoch:s.controlEpoch,cols:terminal.current.cols,rows:terminal.current.rows});
  if(version!==resizeVersion.current||session.current.controlEpoch!==result.controlEpoch||session.current.runtimeEpoch!==result.runtimeEpoch)return;
  session.current=result;resized.current=true;current.current.onSession(result);syncGate();
 };
 useImperativeHandle(ref,()=>({
  claim:async()=>{if(!inputSupported.current)throw new Error('当前终端版本无法验证输入来源');if(!snapshotReady.current)throw new Error('终端快照尚未就绪');resized.current=false;syncGate();const s=session.current;const result=await props.rpc.request<Session>(s.hostId,'claimControl',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch});session.current=result;inputSeq.current=0;current.current.onSession(result);await resize();terminal.current?.focus()},
  interrupt:async()=>{if(!permitted())throw new Error('请先接管控制');const s=session.current;await props.rpc.request(s.hostId,'interrupt',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,controlEpoch:s.controlEpoch})},
  terminate:async()=>{if(!permitted())throw new Error('请先接管控制');const s=session.current;await props.rpc.request(s.hostId,'terminate',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,controlEpoch:s.controlEpoch,confirm:true})},
  find:(text,previous=false)=>text?(previous?search.current?.findPrevious(text):search.current?.findNext(text))??false:false,
  copy:async()=>{const selection=terminal.current?.getSelection();if(!selection)throw new Error('请先在终端中选择要复制的文字');await navigator.clipboard.writeText(selection)}
 }));
 useEffect(()=>{
  const term=new Terminal({fontSize:props.fontSize,fontFamily:'"SFMono-Regular", Menlo, Consolas, monospace',lineHeight:1.25,scrollback:10000,convertEol:false,disableStdin:true,allowProposedApi:false,screenReaderMode:true,cursorBlink:false,linkHandler:{allowNonHttpProtocols:false,activate:(event,text)=>{if(!event.isTrusted)return;try{const url=new URL(text);if(['http:','https:'].includes(url.protocol)&&window.confirm(`打开终端中的链接？\n${url.href}`))window.open(url.href,'_blank','noopener,noreferrer')}catch{current.current.onError('此终端链接无效')}}},theme:{background:getComputedStyle(document.documentElement).getPropertyValue('--terminal').trim()||'#101e3d',foreground:'#e3ebf7',cursor:'#a5c7ff'}});
  const fitter=new FitAddon(),finder=new SearchAddon();term.loadAddon(fitter);term.loadAddon(finder);term.open(container.current!);terminal.current=term;fit.current=fitter;search.current=finder;
  // WebGL is optional; canvas context loss falls back to xterm's DOM renderer.
  try{const webgl=new WebglAddon();webgl.onContextLoss(()=>webgl.dispose());term.loadAddon(webgl)}catch{/* DOM renderer remains available. */}
  const clipboardGuard=term.parser.registerOscHandler(52,()=>true);
  const highlights=highlightTerminalInputs(term,props.session.agent);
  const subscription=onTerminalUserInput(term,data=>{
   if(!permitted())return;
   if(new TextEncoder().encode(data).byteLength>16384){current.current.onError('本次输入超过 16 KiB，请分段粘贴');return}
   const s=session.current;const seq=++inputSeq.current;
   void props.rpc.request(s.hostId,'input',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,controlEpoch:s.controlEpoch,inputSeq:seq,data}).catch(e=>{resized.current=false;syncGate();current.current.onError(e.message)});
  },message=>{inputSupported.current=false;current.current.onError(message);term.options.disableStdin=true});
  let resizeTimer:ReturnType<typeof setTimeout>;const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>void resize().catch(e=>current.current.onError(e.message)),120)});observer.observe(container.current!);
  return ()=>{clearTimeout(resizeTimer);observer.disconnect();subscription.dispose();clipboardGuard.dispose();highlights.dispose();term.dispose();terminal.current=null;fit.current=null;search.current=null};
 },[]);
 useEffect(()=>{const t=terminal.current;if(!t)return;t.options.fontSize=props.fontSize;t.options.theme={background:getComputedStyle(document.documentElement).getPropertyValue('--terminal').trim(),foreground:'#e3ebf7',cursor:'#a5c7ff',selectionBackground:'#526d9690'};void resize().catch(e=>current.current.onError(e.message))},[props.fontSize,props.palette]);
 useEffect(()=>{
  const s=props.session;const term=terminal.current!;let disposed=false,failed=false,snapshotVersion=0,attaching=false,resyncPending=false,ackFloor=0;let cursor=new OutputCursor(s.runtimeEpoch);snapshotReady.current=false;resized.current=false;resizeVersion.current++;writeChain.current=Promise.resolve();syncGate();
  if(props.connection!=='online'||!props.hostOnline)return;
  const acknowledge=(seq:number)=>{if(!disposed&&seq>=ackFloor)void props.rpc.request(s.hostId,'outputAck',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,seq}).catch(e=>{if(seq>=ackFloor)fail(e)})};
  const fail=(e:unknown)=>{if(disposed||failed)return;failed=true;snapshotReady.current=false;resized.current=false;syncGate();setHint('终端读取失败 · 点击重新读取终端重试');current.current.onError(e instanceof Error?e.message:String(e));void props.rpc.request(s.hostId,'detach',{sessionId:s.id}).catch(()=>{})};
  const write=(data:string,seq:number,geometry?:{cols:number;rows:number})=>{
   writeChain.current=writeChain.current.then(()=>new Promise<void>(resolve=>{if(disposed||failed){resolve();return}if(geometry){term.reset();term.resize(geometry.cols,geometry.rows)}term.write(data,()=>{if(!disposed&&!failed)acknowledge(seq);resolve()})}));return writeChain.current;
  };
  const applySnapshot=async(snapshot:Snapshot,initial:boolean)=>{
   if(disposed||failed)return;
   if(snapshot.session.runtimeEpoch!==s.runtimeEpoch){current.current.onSession(snapshot.session);return}
   const version=++snapshotVersion;ackFloor=Math.max(ackFloor,snapshot.seq);snapshotReady.current=false;syncGate();
   if(session.current.controlEpoch!==snapshot.session.controlEpoch||session.current.controller!==snapshot.session.controller)resized.current=false;
   session.current=snapshot.session;current.current.onSession(snapshot.session);
   // Broadcast snapshots are authoritative after another viewer resizes the PTY.
   // Serialize reset with all earlier writes; subsequent output is queued behind it.
   const queued=initial?cursor.snapshot(snapshot.seq):[];
   if(!initial){cursor=new OutputCursor(s.runtimeEpoch);cursor.snapshot(snapshot.seq)}
   void write(snapshot.data,snapshot.seq,{cols:snapshot.cols,rows:snapshot.rows});
   for(const item of queued)void write(item.data,item.seq);
   await writeChain.current;if(disposed||failed||version!==snapshotVersion)return;
   snapshotReady.current=true;syncGate();
   if(snapshot.truncated)current.current.onError('当前快照已截断；可在历史记录中查看较早输出');
  };
  const attach=()=>{
   if(disposed||failed)return;if(attaching){resyncPending=true;return}attaching=true;const version=snapshotVersion;snapshotReady.current=false;resized.current=false;cursor=new OutputCursor(s.runtimeEpoch);syncGate();
   void props.rpc.request<Snapshot>(s.hostId,'attach',{sessionId:s.id}).then(snapshot=>{if(version===snapshotVersion)return applySnapshot(snapshot,true)}).catch(fail).finally(()=>{attaching=false;if(resyncPending){resyncPending=false;attach()}});
  };
  const unsubscribe=props.rpc.subscribe((event:Output&Snapshot)=>{
   if(event.type!=='event'||event.hostId!==s.hostId||event.sessionId!==s.id||event.clientId!==props.rpc.clientId)return;
   try{if(event.event==='output'){for(const item of cursor.push(event))void write(item.data,item.seq)}else if((event.event as string)==='snapshot'){void applySnapshot(event,false).catch(fail)}else if((event.event as string)==='resync'){attach()}}catch(e){fail(e)}
  });
  attach();
  return ()=>{disposed=true;unsubscribe();snapshotReady.current=false;resized.current=false;resizeVersion.current++;void props.rpc.request(s.hostId,'detach',{sessionId:s.id}).catch(()=>{})};
 },[props.session.id,props.session.runtimeEpoch,props.connection,props.hostOnline]);

 return <><div className="terminal-container" ref={container} aria-label="Agent 实时终端"/><div className="terminal-footer"><span role="status">{hint}</span></div></>;
});
