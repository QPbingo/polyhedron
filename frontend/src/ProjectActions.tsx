import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export function ProjectActions({name,canCreate,onCreate,onSettings}:{name:string;canCreate:boolean;onCreate:()=>void;onSettings:()=>void}){
 const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),id=useId();
 const [position,setPosition]=useState<{left:number;top:number}|null>(null);
 const close=()=>setPosition(null);
 useLayoutEffect(()=>{if(position)menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()},[position]);
 useEffect(()=>{
  if(!position)return;
  const outside=(e:PointerEvent)=>{if(!menu.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))close()};
  const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();trigger.current?.focus()}};
  const scroll=(e:Event)=>{if(!menu.current?.contains(e.target as Node))close()};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);window.addEventListener('resize',close);window.addEventListener('scroll',scroll,true);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);window.removeEventListener('resize',close);window.removeEventListener('scroll',scroll,true)};
 },[position]);
 return <>
  <button ref={trigger} type="button" className="icon-button project-menu-trigger" aria-label={`${name} 项目操作`} title="项目操作" aria-haspopup="menu" aria-expanded={!!position} aria-controls={position?id:undefined} onClick={()=>{if(position){close();return}const r=trigger.current!.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(r.right-164,window.innerWidth-172)),top:Math.max(8,Math.min(r.bottom+4,window.innerHeight-96))})}}><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
  {position&&createPortal(<div ref={menu} id={id} role="menu" aria-label={`${name} 项目操作`} className="project-action-menu" style={position} onKeyDown={e=>{
   if(e.key==='Tab'){close();return}if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const items=Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')),i=items.indexOf(document.activeElement as HTMLButtonElement);const next=e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
  }}><button type="button" role="menuitem" disabled={!canCreate} onClick={()=>{close();onCreate()}}>新建会话</button><button type="button" role="menuitem" onClick={()=>{close();onSettings()}}>项目设置</button></div>,document.body)}
 </>;
}
