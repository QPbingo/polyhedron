import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RpcClient} from '../src/api.ts';
class Socket {
 static OPEN=1;static current:Socket;
 readyState=1;bufferedAmount=0;
 onopen:()=>void=()=>{};onclose:()=>void=()=>{};onerror:()=>void=()=>{};onmessage:(event:{data:string})=>void=()=>{};
 sent:string[]=[];binaryType='';
 constructor(_url:string){Socket.current=this}
 send(data:string){this.sent.push(data)}
 close(){this.onclose()}
}
test('RPC bounds pending work and socket buffers without replaying rejected requests',async()=>{
 const originalSocket=globalThis.WebSocket,originalLocation=globalThis.location;
 Object.assign(globalThis,{WebSocket:Socket,location:{protocol:'http:',host:'127.0.0.1'}});
 const rpc=new RpcClient();try{
  rpc.connect();const socket=Socket.current;socket.onopen();
  const pending=Array.from({length:64},()=>rpc.request('h','input',{data:'x'}).catch(e=>e));
  await assert.rejects(rpc.request('h','input',{data:'overflow'}),{code:'BACKPRESSURE'});assert.equal(socket.sent.length,64);
  for(const frame of socket.sent){const request=JSON.parse(frame);socket.onmessage({data:JSON.stringify({type:'response',id:request.id,result:{ok:true}})})}
  await Promise.all(pending);socket.bufferedAmount=2*1024*1024;
  await assert.rejects(rpc.request('h','input',{data:'overflow'}),{code:'BACKPRESSURE'});assert.equal(socket.sent.length,64);
  rpc.close();await assert.rejects(rpc.request('h','input',{data:'offline'}),{code:'OFFLINE'});assert.equal(socket.sent.length,64);
 }finally{rpc.close();Object.assign(globalThis,{WebSocket:originalSocket,location:originalLocation})}
});
