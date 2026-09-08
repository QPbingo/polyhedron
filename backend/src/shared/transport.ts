import type WebSocket from 'ws';
const budgets=new WeakMap<WebSocket,{snapshotBytes:number}>();
/** Large snapshot envelopes have their own bounded budget, not permission for
 * ordinary output to queue 8 MiB behind a slow socket. */
export function forwardBounded(socket:WebSocket,data:string|Buffer|ArrayBuffer|Buffer[],binary:boolean):boolean{
 if(socket.readyState!==1)return false;
 const size=typeof data==='string'?Buffer.byteLength(data):Array.isArray(data)?data.reduce((n,b)=>n+b.length,0):data.byteLength;
 const state=budgets.get(socket)??{snapshotBytes:0};budgets.set(socket,state);
 let snapshot=false;
 if(!binary&&size>128*1024){try{const text=typeof data==='string'?data:Array.isArray(data)?Buffer.concat(data).toString():Buffer.from(data as ArrayBuffer).toString();const message=JSON.parse(text);snapshot=message.type==='result'||message.type==='response'||(message.type==='event'&&message.event==='snapshot');}catch{/* Malformed messages never gain the snapshot budget. */}}
 if(size>8*1024*1024||Math.max(0,socket.bufferedAmount-state.snapshotBytes)>2*1024*1024||(snapshot?state.snapshotBytes+size>8*1024*1024:Math.max(0,socket.bufferedAmount-state.snapshotBytes)+size>2*1024*1024)){socket.close(1013,'Slow connection; resync required');return false;}
 if(snapshot)state.snapshotBytes+=size;
 socket.send(data,{binary},()=>{if(snapshot)state.snapshotBytes-=size;});return true;
}
