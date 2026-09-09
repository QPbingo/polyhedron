import type {Connection} from '../api';
import type {Project,Session} from '../types';
import {ToolButton} from './ToolButton';

interface Props{
 connection:Connection;
 project?:Project;
 session?:Session;
 userName?:string;
 focus:boolean;
 onToggleFocus:()=>void;
 onOpenSettings:()=>void;
}

const connectionLabel:Record<Connection,string>={online:'本机已连接',connecting:'正在重连',offline:'连接已断开'};

export function ShellHeader({connection,project,session,userName,focus,onToggleFocus,onOpenSettings}:Props){
 const initials=(userName||'LC').trim().slice(0,2).toUpperCase();
 return <header className="shell-header glass-surface">
  <div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><i/><i/></span><strong>多面体</strong><span>Agent workbench</span></div>
  <div className="shell-breadcrumb" aria-label="当前位置"><span>Projects</span>{project&&<><i>/</i><span>{project.name}</span></>}{session&&<><i>/</i><strong>{session.title}</strong></>}</div>
  <div className="shell-actions"><span className={`connection-capsule ${connection}`} role="status"><i/><span>{connectionLabel[connection]}</span></span><ToolButton label={focus?'退出专注模式':'进入专注模式'} icon="expand" pressed={focus} onClick={onToggleFocus}/><ToolButton label="设置" icon="settings" onClick={onOpenSettings}/><span className="user-avatar" aria-label={userName||'当前用户'}>{initials}</span></div>
 </header>;
}
