import WebSocket from 'ws';
import {join} from 'node:path';
import {loadConnectorConfig} from '../host/config.js';
import {forwardBounded} from '../shared/transport.js';
const config=await loadConnectorConfig();let stopped=false,delay=500,timer:NodeJS.Timeout|undefined;let local:WebSocket|undefined,remote:WebSocket|undefined;
function connect(){
 if(stopped)return;
 local=new WebSocket('ws+unix://'+join(config.dataDir!,'host.sock')+':/ipc',{headers:{authorization:'Bearer '+config.ipcToken},maxPayload:8*1024*1024});
 const ipc=local;let settled=false,heartbeat:NodeJS.Timeout|undefined;let alive=true;
 const retry=()=>{if(settled)return;settled=true;clearInterval(heartbeat);ipc.terminate();remote?.terminate();if(!stopped){timer=setTimeout(connect,delay+Math.random()*250);delay=Math.min(delay*2,10000);}};
 ipc.on('open',()=>{
  remote=new WebSocket(config.relayUrl,{headers:{authorization:'Bearer '+config.hostToken,'x-host-id':config.hostId},maxPayload:8*1024*1024});const relay=remote;
  relay.on('open',()=>{delay=500;console.log('主机已连接中继');heartbeat=setInterval(()=>{if(!alive){retry();return;}alive=false;relay.ping();},10000);});relay.on('pong',()=>{alive=true;});
  relay.on('message',(data,binary)=>{if(!forwardBounded(ipc,data,binary))retry();});
  relay.on('close',retry);relay.on('error',()=>retry());
 });
 ipc.on('message',(data,binary)=>{if(remote?.readyState!==WebSocket.OPEN)return;if(!forwardBounded(remote,data,binary))retry();});ipc.on('close',retry);ipc.on('error',()=>retry());
}
const stop=()=>{stopped=true;clearTimeout(timer);local?.terminate();remote?.terminate();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);connect();
