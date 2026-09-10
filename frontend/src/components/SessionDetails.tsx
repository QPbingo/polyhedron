import {active,statusName,type Host,type Project,type Session} from '../types';
import {ToolButton} from './ToolButton';

interface Props{
 session:Session;
 project?:Project;
 host?:Host;
 canUse:boolean;
 busy:boolean;
 channelId:string|null;
 onClose:()=>void;
 onClaim:()=>void;
 onInterrupt:()=>void;
 onRename:()=>void;
 onHistory:()=>void;
 onResume:()=>void;
 onArchive:()=>void;
 onTerminate:()=>void;
 onRecover:()=>void;
 onDelete:()=>void;
}

function date(value:string|number){const parsed=new Date(value);return Number.isNaN(parsed.getTime())?value:parsed.toLocaleString('zh-CN')}
function bytes(value:number){if(value<1024)return `${value} B`;if(value<1024*1024)return `${(value/1024).toFixed(1)} KiB`;if(value<1024*1024*1024)return `${(value/1024/1024).toFixed(1)} MiB`;return `${(value/1024/1024/1024).toFixed(1)} GiB`}

export function SessionDetails({session,project,host,canUse,busy,channelId,onClose,onClaim,onInterrupt,onRename,onHistory,onResume,onArchive,onTerminate,onRecover,onDelete}:Props){
 return <aside className="session-details-sheet" role="region" aria-label="会话详情">
  <header className="details-header"><div><span className="eyebrow">Active session</span><h2>{session.title}</h2><p className="project-directory">{project?.path}</p></div><ToolButton label="关闭会话详情" icon="close" onClick={onClose}/></header>
  <div className="details-status"><span className={`dot ${session.activity}`}/><span>{statusName(session)}{session.statusSource?` · ${session.statusSource}`:''}</span></div>
  <dl className="facts">
   <div><dt>主机</dt><dd>{host?.name||session.hostId} · {canUse?'已连接':'离线'}</dd></div>
   <div><dt>项目</dt><dd>{project?.name||session.projectId}</dd></div>
   <div><dt>操作权</dt><dd>{session.controller===channelId?'当前窗口':session.controller?'其他窗口':'尚未接管'}</dd></div>
   <div><dt>创建于</dt><dd>{date(session.createdAt)}</dd></div>
   {session.historyBytes!==undefined&&<div><dt>本地历史</dt><dd>{bytes(session.historyBytes)}</dd></div>}
   <div><dt>会话 ID</dt><dd className="mono">{session.id}</dd></div>
   {session.exitCode!=null&&<div><dt>退出码</dt><dd>{session.exitCode}</dd></div>}
  </dl>
  {session.warning&&<p className="form-error">{session.warning}</p>}
  {session.journalState!=='ready'&&<button className="secondary full-width" disabled={!canUse||busy} onClick={onRecover}>校验并恢复本地记录</button>}
  <div className="detail-primary-actions">
   <button className="primary full-width" disabled={!canUse||!active(session)||busy||session.journalState!=='ready'} onClick={onClaim}>接管控制</button>
   <button className="secondary full-width" disabled={!canUse||session.controller!==channelId||!active(session)||busy||session.journalState!=='ready'} onClick={onInterrupt}>中断任务</button>
  </div>
  <div className="session-actions">
   <button className="text-button" disabled={!canUse} onClick={onRename}>重命名</button>
   <button className="text-button" disabled={!canUse||session.journalState!=='ready'} onClick={onHistory}>历史记录</button>
   {!active(session)?<><button className="text-button" disabled={!canUse||!session.nativeSessionId||busy||session.journalState!=='ready'} title={session.nativeSessionId?'恢复此原生会话':'尚未记录原生会话 ID，无法准确恢复'} onClick={onResume}>恢复会话</button><button className="text-button" disabled={!canUse||busy||session.journalState!=='ready'} onClick={onArchive}>{session.archived?'取消归档':'归档'}</button><button className="text-button danger" disabled={!canUse||busy} onClick={onDelete}>删除历史</button></>:<button className="text-button danger" disabled={!canUse||session.controller!==channelId||busy||session.journalState!=='ready'} onClick={onTerminate}>终止进程</button>}
  </div>
  <p className="details-note">玻璃层仅承载导航与操作控件；终端内容保持高对比、清晰可读。</p>
 </aside>;
}
