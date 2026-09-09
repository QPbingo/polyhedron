import type {RefObject} from 'react';
import type {Connection} from '../api';
import {ProjectActions} from '../ProjectActions';
import {active,agentName,statusName,type Host,type Project,type Session} from '../types';
import {Icon} from './Icon';
import {ToolButton} from './ToolButton';

export type SessionFilter='all'|'pending'|'done'|'archived';

interface Props{
 hosts:Host[];
 projects:Project[];
 sessions:Session[];
 loaded:boolean;
 connection:Connection;
 filter:SessionFilter;
 query:string;
 collapsed:Set<string>;
 selected:string|null;
 seenCompletions:Record<string,string>;
 searchInput:RefObject<HTMLInputElement|null>;
 onQueryChange:(value:string)=>void;
 onFilterChange:(filter:SessionFilter)=>void;
 onToggleProject:(projectId:string)=>void;
 onSelectSession:(session:Session)=>void;
 onAddProject:()=>void;
 onCreateSession:(project:Project)=>void;
 onEditProject:(project:Project)=>void;
 onOpenHelp:()=>void;
}

function shortPath(path:string){return path.replace(/^\/Users\/[^/]+\//,'~/').replace(/^\/home\/[^/]+\//,'~/')}

export function Sidebar({hosts,projects,sessions,loaded,connection,filter,query,collapsed,selected,seenCompletions,searchInput,onQueryChange,onFilterChange,onToggleProject,onSelectSession,onAddProject,onCreateSession,onEditProject,onOpenHelp}:Props){
 const isPending=(session:Session)=>session.activity==='approval'||session.activity==='idle'&&active(session)&&!!hosts.find(host=>host.id===session.hostId)?.online;
 const visibleSessions=sessions.filter(session=>(filter==='archived'?session.archived:!session.archived)&&(filter!=='pending'||isPending(session))&&(filter!=='done'||!active(session)||session.activity==='done'));
 const filters:[SessionFilter,string,string][]=[['all','全部会话',String(sessions.filter(session=>!session.archived).length)],['pending','待处理',String(sessions.filter(session=>!session.archived&&isPending(session)).length)],['done','已结束','']];
 return <aside className="sidebar" aria-label="会话与设备">
  <div className="sidebar-top">
   <label className="session-search glass-control"><Icon name="search"/><input ref={searchInput} type="search" value={query} onChange={event=>onQueryChange(event.target.value)} placeholder="搜索项目或会话" aria-label="搜索会话或项目"/><kbd>⌘ K</kbd></label>
   <nav className="session-filters glass-control" aria-label="会话功能">{filters.map(([id,label,count])=><button key={id} className="sidebar-function" aria-label={count?`${label} ${count}`:label} aria-pressed={filter===id} onClick={()=>onFilterChange(id)}>{label}{count&&<span className="function-count">{count}</span>}</button>)}</nav>
  </div>
  <section className="projects-section" aria-labelledby="projects-heading">
   <div className="projects-heading"><h2 id="projects-heading">Projects <span id="project-count">{projects.length}</span></h2><ToolButton label="添加项目" icon="plus" onClick={onAddProject} disabled={connection!=='online'}/></div>
   <nav className="project-list" aria-label="项目与会话">
    {!loaded?<p className="session-empty">正在加载项目…</p>:projects.length===0?<p className="session-empty">{hosts.length?'添加一个项目目录，开始你的第一个会话。':'先在设置中配对执行主机，再添加项目。'}</p>:projects.map(project=>{
     const host=hosts.find(item=>item.id===project.hostId),normalizedQuery=query.trim().toLowerCase(),projectMatch=`${project.name} ${project.path} ${shortPath(project.path)}`.toLowerCase().includes(normalizedQuery);
     const projectSessions=visibleSessions.filter(session=>session.projectId===project.id&&(projectMatch||`${session.title} ${agentName(session.agent)}`.toLowerCase().includes(normalizedQuery)));
     const expanded=!!normalizedQuery||filter!=='all'||!collapsed.has(project.id);
     if((normalizedQuery||filter!=='all')&&!projectSessions.length&&!(normalizedQuery&&projectMatch))return null;
     return <div key={project.id} className="project-group">
      <div className="project-heading"><button className="project-toggle" aria-expanded={expanded} title={`${project.path}\n${host?.name||project.hostId}`} onClick={()=>onToggleProject(project.id)}><Icon name="chevron" className="project-chevron"/><Icon name="folder"/><span className="project-label"><strong>{project.name}</strong></span></button><ProjectActions name={project.name} canCreate={!!host?.online&&connection==='online'} onCreate={()=>onCreateSession(project)} onSettings={()=>onEditProject(project)}/></div>
      {expanded&&<div className="session-list">{projectSessions.length?projectSessions.map(session=><button key={session.id} className={`session-item${session.id===selected?' active':''}`} aria-current={session.id===selected?'page':undefined} onClick={()=>onSelectSession(session)}><div className="session-name">{session.title}{session.activity==='done'&&session.id!==selected&&seenCompletions[session.id]!==session.updatedAt&&<span className="unread-completion" aria-label="本轮完成，尚未查看" title="本轮完成，尚未查看"/>}</div><div className="session-meta"><span className={`dot ${session.activity}`}/><span>{agentName(session.agent)}</span><span>·</span><span>{session.archived?'已归档':statusName(session)}</span></div></button>):<p className="project-empty">暂无会话</p>}</div>}
     </div>;
    })}
   </nav>
  </section>
  <div className="sidebar-utilities"><button className="sidebar-action glass-control" onClick={onOpenHelp}><Icon name="book"/>使用指南</button></div>
 </aside>;
}
