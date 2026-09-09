import {Icon} from './components/Icon';

interface Props{
 name:string;
 canCreate:boolean;
 onCreate:()=>void;
 onSettings:()=>void;
}

export function ProjectActions({name,canCreate,onCreate,onSettings}:Props){
 return <span className="project-actions">
  <button type="button" className="project-action" aria-label={`在 ${name} 中新建会话`} title="新建会话" disabled={!canCreate} onClick={onCreate}><Icon name="plus"/></button>
  <button type="button" className="project-action" aria-label={`${name} 项目设置`} title="项目设置" onClick={onSettings}><Icon name="more"/></button>
 </span>;
}
