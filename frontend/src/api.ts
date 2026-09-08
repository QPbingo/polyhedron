import {decodeOutput} from './protocol.ts';
export class ApiError extends Error {code:string;status?:number;constructor(code:string,message:string,status?:number){super(message);this.code=code;this.status=status}}
export async function http<T>(url:string,body?:unknown,csrf?:string):Promise<T>{
 const response=await fetch(url,{credentials:'same-origin',headers:body===undefined?undefined:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw new ApiError(data?.error?.code||String(response.status),data?.error?.message||`请求失败 (${response.status})`,response.status);
 return data;
}
export type Connection = 'connecting'|'online'|'offline';
export class RpcClient {
 readonly clientId=crypto.randomUUID(); socket:WebSocket|null=null;state:Connection='offline';
 private pending=new Map<string,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private listeners=new Set<(data:any)=>void>();private connections=new Set<(state:Connection)=>void>();private timer:ReturnType<typeof setTimeout>|undefined;private closed=true;private attempt=0;
 subscribe(fn:(data:any)=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn)}}
 onConnection(fn:(s:Connection)=>void){this.connections.add(fn);return ()=>{this.connections.delete(fn)}}
 private setState(s:Connection){this.state=s;this.connections.forEach(fn=>fn(s))}
 connect(){this.closed=false;this.open()}
 private open(){
  if(this.closed)return;this.setState('connecting');
  const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws/browser?clientId=${encodeURIComponent(this.clientId)}`);this.socket=socket;socket.binaryType='arraybuffer';
  socket.onopen=()=>{if(this.socket!==socket)return;this.attempt=0;this.setState('online')};
  socket.onmessage=e=>{try{if(typeof e.data==='string'&&new TextEncoder().encode(e.data).byteLength>8*1024*1024)throw new Error('Frame exceeds 8 MiB');const data=e.data instanceof ArrayBuffer?decodeOutput(e.data):JSON.parse(e.data);if(data.type==='response'){const req=this.pending.get(data.id);if(!req)return;clearTimeout(req.timer);this.pending.delete(data.id);data.error?req.reject(new ApiError(data.error.code,data.error.message)):req.resolve(data.result)}else this.listeners.forEach(fn=>fn(data))}catch{socket.close(1002,'Invalid frame')}};
  socket.onclose=()=>{if(this.socket!==socket)return;this.setState('offline');this.pending.forEach(p=>{clearTimeout(p.timer);p.reject(new ApiError('DISCONNECTED','连接已断开；未确认的输入不会重发'))});this.pending.clear();if(!this.closed)this.timer=setTimeout(()=>this.open(),Math.min(15000,800*2**this.attempt++)+Math.random()*300)};
  socket.onerror=()=>socket.close();
 }
 request<T>(hostId:string,method:string,params:object={}):Promise<T>{
  if(this.state!=='online'||this.socket?.readyState!==WebSocket.OPEN)return Promise.reject(new ApiError('OFFLINE','连接未就绪，请稍后重试'));
  if(this.pending.size>=64||this.socket.bufferedAmount>=2*1024*1024)return Promise.reject(new ApiError('BACKPRESSURE','输入发送过快，已暂停；未确认的输入不会重发'));
  const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new ApiError('TIMEOUT','请求超时，请刷新状态后确认结果'))},20000);this.pending.set(id,{resolve,reject,timer});this.socket!.send(JSON.stringify({type:'request',id,hostId,method,params}))});
 }
 close(){this.closed=true;clearTimeout(this.timer);this.socket?.close();this.setState('offline')}
}
