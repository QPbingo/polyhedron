import {ChannelError,SecureChannel} from './secureChannel.ts';

export class ApiError extends Error {code:string;status?:number;fingerprint?:string;constructor(code:string,message:string,status?:number,fingerprint?:string){super(message);this.code=code;this.status=status;this.fingerprint=fingerprint}}
export async function http<T>(url:string,body?:unknown,csrf?:string):Promise<T>{
 const response=await fetch(url,{credentials:'same-origin',headers:body===undefined?undefined:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json().catch(()=>null);
 if(!response.ok)throw new ApiError(data?.error?.code||String(response.status),data?.error?.message||`请求失败 (${response.status})`,response.status);
 return data;
}
export type Connection = 'connecting'|'online'|'offline';
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;channelId:string};
type Opening={hostId:string;channel:SecureChannel;resolve:(channel:SecureChannel)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};

export class RpcClient {
 readonly clientId=crypto.randomUUID();socket:WebSocket|null=null;state:Connection='offline';
 private pending=new Map<string,Pending>();private opening=new Map<string,Opening>();private channels=new Map<string,SecureChannel>();private channelPromises=new Map<string,Promise<SecureChannel>>();
 private queuedRequests=0;private receiveChain:Promise<void>=Promise.resolve();
 private listeners=new Set<(data:any)=>void>();private connections=new Set<(state:Connection)=>void>();private timer:ReturnType<typeof setTimeout>|undefined;private closed=true;private attempt=0;
 subscribe(fn:(data:any)=>void){this.listeners.add(fn);return ()=>{this.listeners.delete(fn)}}
 onConnection(fn:(s:Connection)=>void){this.connections.add(fn);return ()=>{this.connections.delete(fn)}}
 channelId(hostId:string){return this.channels.get(hostId)?.channelId??null}
 fingerprint(hostId:string){return localStorage.getItem(`polyhedron.host-fingerprint.${hostId}`)}
 private setState(state:Connection){this.state=state;this.connections.forEach(fn=>fn(state))}
 connect(){this.closed=false;this.open()}
 private rejectAll(error:ApiError){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error)}this.pending.clear();for(const item of this.opening.values()){clearTimeout(item.timer);item.reject(error)}this.opening.clear();this.channels.clear();this.channelPromises.clear()}
 private open(){
  if(this.closed)return;this.setState('connecting');const socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws/browser?clientId=${encodeURIComponent(this.clientId)}`);this.socket=socket;
  socket.onopen=()=>{if(this.socket!==socket)return;this.attempt=0;this.setState('online')};
  socket.onmessage=event=>{this.receiveChain=this.receiveChain.then(()=>this.receive(socket,event.data))};
  socket.onclose=()=>{if(this.socket!==socket)return;this.setState('offline');this.rejectAll(new ApiError('DISCONNECTED','连接已断开；未确认的输入不会重发'));if(!this.closed)this.timer=setTimeout(()=>this.open(),Math.min(15000,800*2**this.attempt++)+Math.random()*300)};
  socket.onerror=()=>socket.close();
 }
 private async receive(socket:WebSocket,raw:unknown){
  try{
   if(this.socket!==socket||typeof raw!=='string'||new TextEncoder().encode(raw).byteLength>8*1024*1024)throw new Error('Invalid encrypted frame');const data=JSON.parse(raw);
   if(data.type==='channel_opened'){
    const item=this.opening.get(data.id);if(!item||item.channel.channelId!==data.channelId||item.hostId!==data.hostId)return;try{await item.channel.complete(data.hello)}catch(error){clearTimeout(item.timer);this.opening.delete(data.id);this.channelPromises.delete(item.hostId);item.reject(error instanceof ChannelError?new ApiError(error.code,error.message,undefined,error.fingerprint):new ApiError('INVALID_HANDSHAKE','无法验证执行主机'));socket.close(4002,'Invalid host identity');return}clearTimeout(item.timer);this.opening.delete(data.id);this.channels.set(item.hostId,item.channel);item.resolve(item.channel);return;
   }
   if(data.type==='sealed_result'){
    const channel=this.channels.get(data.hostId);if(!channel||channel.channelId!==data.channelId)throw new Error('Unknown encrypted channel');const response=await channel.open(data.cipher),item=this.pending.get(response.id);if(!item||item.channelId!==data.channelId)return;clearTimeout(item.timer);this.pending.delete(response.id);response.error?item.reject(new ApiError(response.error.code,response.error.message)):item.resolve(response.result);return;
   }
   if(data.type==='sealed_event'){
    const channel=this.channels.get(data.hostId);if(!channel||channel.channelId!==data.channelId)throw new Error('Unknown encrypted channel');const event=await channel.open(data.cipher);this.listeners.forEach(fn=>fn(event));return;
   }
   if(data.type==='response'&&typeof data.id==='string'){
    const opening=this.opening.get(data.id);if(opening){clearTimeout(opening.timer);this.opening.delete(data.id);this.channelPromises.delete(opening.hostId);opening.reject(new ApiError(data.error?.code??'CHANNEL_FAILED',data.error?.message??'安全通道建立失败'));return}const item=this.pending.get(data.id);if(item){clearTimeout(item.timer);this.pending.delete(data.id);if(['CHANNEL_NOT_FOUND','UNAUTHORIZED'].includes(data.error?.code)){for(const [hostId,channel]of this.channels)if(channel.channelId===item.channelId){this.channels.delete(hostId);this.channelPromises.delete(hostId)}}item.reject(new ApiError(data.error?.code??'REQUEST_FAILED',data.error?.message??'请求失败'));}return;
   }
   if(data.type==='event'&&data.event==='state'&&data.host){if(data.host.online===false){this.channels.delete(data.host.id);this.channelPromises.delete(data.host.id)}this.listeners.forEach(fn=>fn(data))}else throw new Error('Unsealed content frame');
  }catch{socket.close(4002,'Invalid encrypted frame')}
 }
 async openHost(hostId:string):Promise<SecureChannel>{
  const active=this.channels.get(hostId);if(active)return active;const current=this.channelPromises.get(hostId);if(current)return current;if(this.state!=='online'||this.socket?.readyState!==WebSocket.OPEN)throw new ApiError('OFFLINE','连接未就绪，请稍后重试');
  const promise=(async()=>{const channel=await SecureChannel.begin(hostId),id=crypto.randomUUID();return new Promise<SecureChannel>((resolve,reject)=>{const timer=setTimeout(()=>{this.opening.delete(id);this.channelPromises.delete(hostId);reject(new ApiError('TIMEOUT','安全通道握手超时'))},15000);this.opening.set(id,{hostId,channel,resolve,reject,timer});this.socket!.send(JSON.stringify({type:'open_channel',id,hostId,channelId:channel.channelId,clientPublicKey:channel.hello.clientPublicKey}))})})();this.channelPromises.set(hostId,promise);try{return await promise}catch(error){this.channelPromises.delete(hostId);throw error}
 }
 async request<T>(hostId:string,method:string,params:object={}):Promise<T>{
  if(this.state!=='online'||this.socket?.readyState!==WebSocket.OPEN)throw new ApiError('OFFLINE','连接未就绪，请稍后重试');if(this.queuedRequests>=64||(this.socket?.bufferedAmount??0)>=2*1024*1024)throw new ApiError('BACKPRESSURE','输入发送过快，已暂停；未确认的输入不会重发');this.queuedRequests++;try{const channel=await this.openHost(hostId);if(this.state!=='online'||this.socket?.readyState!==WebSocket.OPEN)throw new ApiError('OFFLINE','连接未就绪，请稍后重试');const id=crypto.randomUUID(),body={...(params as Record<string,unknown>),operationId:(params as Record<string,unknown>).operationId??crypto.randomUUID()},cipher=await channel.seal({type:'request',id,method,params:body});return await new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new ApiError('TIMEOUT','请求超时，请刷新状态后确认结果'))},20000);this.pending.set(id,{resolve,reject,timer,channelId:channel.channelId});this.socket!.send(JSON.stringify({type:'sealed',id,hostId,channelId:channel.channelId,cipher}))})}finally{this.queuedRequests--}
 }
 trustHost(hostId:string,fingerprint:string){if(!/^[A-Za-z0-9_-]{43}$/.test(fingerprint))throw new ApiError('INVALID_FINGERPRINT','执行主机指纹格式无效');localStorage.setItem(`polyhedron.host-fingerprint.${hostId}`,fingerprint);this.reconnect()}
 private reconnect(){if(this.closed)return;clearTimeout(this.timer);const socket=this.socket;this.socket=null;socket?.close();this.rejectAll(new ApiError('DISCONNECTED','正在使用已确认的主机身份重新连接'));this.open()}
 close(){this.closed=true;clearTimeout(this.timer);this.socket?.close();this.rejectAll(new ApiError('DISCONNECTED','连接已关闭'));this.setState('offline')}
}
