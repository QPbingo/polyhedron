import {realpathSync,statSync} from 'node:fs';
import {opendir} from 'node:fs/promises';
import {basename,dirname,join,isAbsolute,relative,sep} from 'node:path';
import {homedir} from 'node:os';
import {Fault} from '../shared/types.js';
export function authorizedPath(input:unknown,roots:string[]):string {
 if(typeof input!=='string'||input.length>4096||/[\0\r\n]/.test(input))throw new Fault('INVALID_PATH','请输入有效的项目目录');
 const path=input==='~'?homedir():input.startsWith('~/')?homedir()+input.slice(1):input;
 if(!isAbsolute(path))throw new Fault('INVALID_PATH','项目目录必须为绝对路径或 ~/ 路径');
 let canonical:string;try{canonical=realpathSync(path);if(!statSync(canonical).isDirectory())throw Error();}catch{throw new Fault('MISSING_DIRECTORY','项目目录不存在或不可读取');}
 const allowed=roots.some(root=>{try{const rel=relative(realpathSync(root),canonical);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));}catch{return false;}});
 if(!allowed)throw new Fault('DIRECTORY_DENIED','项目目录不在本机授权根目录中');
 return canonical;
}
export function title(value:unknown,label='名称'):string{if(typeof value!=='string'||!value.trim()||value.trim().length>48)throw new Fault('INVALID_NAME',label+'须为 1–48 个字符');return value.trim();}

// Folder metadata only. Never read file contents or follow a link outside roots.
export async function listDirectories(input:unknown,roots:string[]){
 const entries:{name:string;path:string}[]=[];
 if(input===undefined){
  for(const root of roots){try{const path=authorizedPath(root,roots);if(!entries.some(e=>e.path===path))entries.push({name:basename(path)||path,path});}catch{/* Unavailable roots are not browsable. */}}
  return {path:null,parent:null,entries,truncated:false};
 }
 const path=authorizedPath(input,roots);let parent:string|null=null;
 try{const candidate=authorizedPath(dirname(path),roots);if(candidate!==path)parent=candidate;}catch{/* Stop at the authorization boundary. */}
 let scanned=0,truncated=false;
 try{
  const directory=await opendir(path);
  for await(const entry of directory){
   if(++scanned>10000||entries.length>=500){truncated=true;break;}
   if(!entry.isDirectory()&&!entry.isSymbolicLink())continue;
   try{entries.push({name:entry.name,path:authorizedPath(join(path,entry.name),roots)});}catch{/* Skip inaccessible directories and escaped links. */}
  }
 }catch{throw new Fault('DIRECTORY_UNREADABLE','无法读取此文件夹，请选择其他目录');}
 entries.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
 return {path,parent,entries,truncated};
}
