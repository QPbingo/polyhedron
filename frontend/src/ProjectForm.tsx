import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {RpcClient} from './api';
import type {Host} from './types';

interface Folder {name:string;path:string}
interface Listing {path:string|null;parent:string|null;entries:Folder[];truncated:boolean}
function FolderIcon(){return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V5h7l2 3h9v12H3z"/></svg>}

function FolderPicker({host,rpc,initialPath,online,onSelect,onClose}:{host:Host;rpc:RpcClient;initialPath:string;online:boolean;onSelect:(path:string)=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),version=useRef(0),requested=useRef<string|undefined>(undefined);
 const [listing,setListing]=useState<Listing|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
 const load=useCallback(async(path?:string)=>{
  const ticket=++version.current;requested.current=path;setLoading(true);setError('');
  try{const result=await rpc.request<Listing>(host.id,'listDirectories',path===undefined?{}:{path});if(ticket===version.current)setListing(result)}
  catch(e){if(ticket===version.current){setListing(null);setError((e as Error).message)}}
  finally{if(ticket===version.current)setLoading(false)}
 },[rpc,host.id]);
 useEffect(()=>{const el=dialog.current!;el.showModal();void load(initialPath||undefined);return()=>{version.current++;el.close()}},[load,initialPath]);
 const unavailable=loading||!online||!host.online;
 return <dialog ref={dialog} className="folder-picker" aria-labelledby="folder-picker-title" onCancel={e=>{e.preventDefault();e.stopPropagation();onClose()}}>
  <div className="dialog-header"><h2 id="folder-picker-title">选择项目文件夹</h2><button type="button" className="icon-button" aria-label="取消选择" onClick={onClose}>×</button></div>
  <p className="folder-host">{host.name} 上的文件夹</p>
  <nav className="folder-navigation" aria-label="文件夹导航"><button type="button" className="text-button" disabled={unavailable} onClick={()=>void load()}>授权目录</button><button type="button" className="text-button" disabled={unavailable||!listing?.parent} onClick={()=>void load(listing!.parent!)}>上一级</button></nav>
  <p className="folder-location" title={listing?.path||''}>{loading?'正在读取文件夹…':listing?.path||'选择一个授权目录'}</p>
  <div className="folder-list" aria-label="文件夹列表" aria-busy={loading}>
   {error?<div className="folder-message"><p className="form-error" role="alert">{error}</p><button type="button" className="text-button" disabled={!online||!host.online} onClick={()=>void load(requested.current)}>重试</button></div>:loading?<p className="folder-message" role="status">正在读取…</p>:listing?.entries.length?<ul>{listing.entries.map(entry=><li key={entry.name+entry.path}><button type="button" className="folder-entry" aria-label={`打开 ${entry.name}`} title={entry.path} disabled={unavailable} onClick={()=>void load(entry.path)}><FolderIcon/><span>{entry.name}</span><span aria-hidden="true">›</span></button></li>)}</ul>:<p className="folder-message">{listing?.path?'此文件夹内没有可浏览的子文件夹。':'此主机没有可用的授权目录。'}</p>}
  </div>
  {listing?.truncated&&<p className="settings-note">文件夹较多，仅显示部分目录。可取消后直接输入完整路径。</p>}
  {(!online||!host.online)&&<p className="form-error" role="alert">主机已断开，请连接后再选择。</p>}
  <div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={unavailable||!listing?.path||!!error} onClick={()=>onSelect(listing!.path!)}>选择此文件夹</button></div>
 </dialog>;
}

export function ProjectForm({hosts,rpc,busy,online,onSubmit}:{hosts:Host[];rpc:RpcClient;busy:boolean;online:boolean;onSubmit:(event:FormEvent<HTMLFormElement>)=>void}){
 const [hostId,setHostId]=useState(()=>hosts.find(h=>h.online)?.id||''),[name,setName]=useState(''),[path,setPath]=useState(''),[picking,setPicking]=useState(false);
 const host=hosts.find(h=>h.id===hostId),available=online&&!!host?.online;
 return <>
  <form onSubmit={onSubmit}>
   <p className="dialog-description">选择执行主机上的项目文件夹。</p>
   <label className="field-label field-block">执行主机<select name="host" className="form-control" required value={hostId} disabled={busy} onChange={e=>{setHostId(e.target.value);setPath('')}}><option value="" disabled>选择在线主机</option>{hosts.map(h=><option key={h.id} value={h.id} disabled={!h.online}>{h.name}{h.online?'':' · 离线'}</option>)}</select></label>
   <label className="field-label field-block" htmlFor="project-path">项目目录</label>
   <div className="folder-field"><input id="project-path" className="form-control" name="path" value={path} onChange={e=>setPath(e.target.value)} placeholder="选择文件夹或输入完整路径" required maxLength={4096} autoComplete="off" disabled={busy}/><button type="button" className="folder-browse" aria-label="选择文件夹" title="选择文件夹" disabled={busy||!available} onClick={()=>setPicking(true)}><FolderIcon/></button></div>
   <label className="field-label field-block">项目名称<input className="form-control" name="name" value={name} onChange={e=>setName(e.target.value)} placeholder="选择文件夹后自动填写，可修改" required maxLength={48} autoComplete="off" disabled={busy}/></label>
   <p className="settings-note">目录必须已存在，并位于此主机配置的授权根目录内。</p>
   <button className="primary full-width" disabled={busy||!available}>添加项目</button>
  </form>
  {picking&&host&&<FolderPicker host={host} rpc={rpc} online={online} initialPath={path} onClose={()=>setPicking(false)} onSelect={selected=>{setPath(selected);if(!name.trim())setName((selected.split('/').filter(Boolean).pop()||selected).slice(0,48));setPicking(false)}}/>}
 </>;
}
