import {useEffect,useRef,type ReactNode} from 'react';
import {ToolButton} from './ToolButton';

export function Modal({title,eyebrow,children,onClose}:{title:string;eyebrow?:string;children:ReactNode;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const element=ref.current!;element.showModal();return()=>element.close()},[]);
 return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event=>{event.preventDefault();onClose()}} onClick={event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose()}}}>
  <div className="dialog-header"><div>{eyebrow&&<span className="dialog-eyebrow">{eyebrow}</span>}<h2 id="dialog-title">{title}</h2></div><ToolButton label="关闭对话框" icon="close" onClick={onClose}/></div>
  {children}
 </dialog>;
}

export function Field({label,name,initial='',placeholder,required=true}:{label:string;name:string;initial?:string;placeholder?:string;required?:boolean}){
 return <label className="field-label field-block">{label}<input className="form-control" name={name} defaultValue={initial} placeholder={placeholder} required={required} maxLength={name==='path'?4096:120} autoComplete="off"/></label>;
}
