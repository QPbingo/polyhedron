import type {RefObject} from 'react';
import type {Connection,RpcClient} from '../api';
import {TerminalView,type TerminalActions} from '../TerminalView';
import {agentName,type Host,type Project,type Session} from '../types';
import {Icon} from './Icon';
import {SessionDetails} from './SessionDetails';
import {ToolButton} from './ToolButton';

interface Props{
 current?:Session;
 project?:Project;
 host?:Host;
 canUse:boolean;
 busy:boolean;
 connection:Connection;
 rpc:RpcClient;
 terminal:RefObject<TerminalActions|null>;
 terminalVersion:number;
 fontSize:number;
 palette:string;
 details:boolean;
 searchOpen:boolean;
 terminalQuery:string;
 hasProjects:boolean;
 hasHosts:boolean;
 onToggleDetails:()=>void;
 onReload:()=>void;
 onToggleSearch:()=>void;
 onSearchQuery:(value:string)=>void;
 onFind:(previous?:boolean)=>void;
 onCopy:()=>void;
 onSession:(session:Session)=>void;
 onError:(message:string)=>void;
 onConnectHost:()=>void;
 onAddProject:()=>void;
 onClaim:()=>void;
 onInterrupt:()=>void;
 onRename:()=>void;
 onHistory:()=>void;
 onResume:()=>void;
 onArchive:()=>void;
 onTerminate:()=>void;
}

export function Workspace({current,project,host,canUse,busy,connection,rpc,terminal,terminalVersion,fontSize,palette,details,searchOpen,terminalQuery,hasProjects,hasHosts,onToggleDetails,onReload,onToggleSearch,onSearchQuery,onFind,onCopy,onSession,onError,onConnectHost,onAddProject,onClaim,onInterrupt,onRename,onHistory,onResume,onArchive,onTerminate}:Props){
 return <section className="workspace-card" id="terminal-workspace" aria-label="当前会话工作区" tabIndex={-1}>
  <section className="terminal-frame" aria-label="Agent 终端">
   <header className="terminal-toolbar">
    <div className="terminal-tab"><span className="terminal-mark"><Icon name="terminal"/></span><div><strong>{current?agentName(current.agent):'终端'}</strong><small>{current?'实时会话 · 可直接输入':'等待选择会话'}</small></div></div>
    <div className="terminal-tools">
     <ToolButton label="重新读取终端" icon="refresh" onClick={onReload} disabled={!current||!canUse}/>
     <ToolButton label="搜索终端" icon="search" onClick={onToggleSearch} disabled={!current}/>
     <ToolButton label="复制所选文字" icon="copy" onClick={onCopy} disabled={!current}/>
     <ToolButton label="会话详情" icon="info" pressed={details} onClick={onToggleDetails} disabled={!current}/>
    </div>
   </header>
   {searchOpen&&<form className="terminal-search glass-control" onSubmit={event=>{event.preventDefault();onFind()}}><input type="search" aria-label="在终端中查找" value={terminalQuery} onChange={event=>onSearchQuery(event.target.value)} autoFocus placeholder="搜索终端输出…" spellCheck={false}/><button type="button" onClick={()=>onFind(true)}>上一个</button><button>下一个</button><ToolButton label="关闭终端搜索" icon="close" onClick={onToggleSearch}/></form>}
   {current?<TerminalView key={`${current.id}:${current.runtimeEpoch}:${terminalVersion}`} ref={terminal} session={current} rpc={rpc} connection={connection} hostOnline={!!host?.online} fontSize={fontSize} palette={palette} onSession={onSession} onError={onError}/>:<div className="workspace-empty"><Icon name="terminal"/><h2>{hasProjects?'选择一个会话，继续工作。':'从一个项目开始。'}</h2><p>{hasProjects?'从左侧选择一个会话，即可继续查看并操作终端。':hasHosts?'点击左侧 Projects 旁的“添加项目”，创建第一个项目。':'在设置中配对你的执行主机。'}</p>{!hasProjects&&hasHosts&&<button className="primary" onClick={onAddProject}>添加第一个项目</button>}{!hasHosts&&<button className="primary" onClick={onConnectHost}>连接执行主机</button>}</div>}
  </section>
  {details&&current&&<SessionDetails session={current} project={project} host={host} canUse={canUse} busy={busy} clientId={rpc.clientId} onClose={onToggleDetails} onClaim={onClaim} onInterrupt={onInterrupt} onRename={onRename} onHistory={onHistory} onResume={onResume} onArchive={onArchive} onTerminate={onTerminate}/>} 
 </section>;
}
