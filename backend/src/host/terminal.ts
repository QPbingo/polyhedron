import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
const {Terminal}=headless,{SerializeAddon}=serialize;
// Checkpoints never stop inside a terminal control sequence. Prefixes wait for
// their terminator across PTY chunks, preventing a restored parser from losing it.
export class TerminalState {
 readonly term=new Terminal({cols:100,rows:30,scrollback:3000,allowProposedApi:true});
 readonly serializer=new SerializeAddon();
 private pending='';
 constructor(){this.term.loadAddon(this.serializer);}
 async write(data:string):Promise<string>{
  const text=this.pending+data;let state='normal',safe=0;
  for(let i=0;i<text.length;i++){
   const c=text[i],code=text.charCodeAt(i);
   if(c==='\x1b'){state='esc';}
   else if(code===0x9b){state='csi';}
   else if(code===0x9d){state='osc';}
   else if(code===0x90||code===0x98||code===0x9e||code===0x9f){state='string';}
   else if(code===0x9c){state='normal';}
   else if(state==='normal'){if(code===0x9b)state='csi';else if(code===0x9d)state='osc';else if(code===0x90||code===0x98||code===0x9e||code===0x9f)state='string';}
   else if(state==='esc'){if(c==='[')state='csi';else if(c===']')state='osc';else if('PX^_'.includes(c))state='string';else if(code>=0x20&&code<=0x2f)state='escapeIntermediate';else state='normal';}
   else if(state==='escapeIntermediate'){if(code>=0x30&&code<=0x7e)state='normal';}
   else if(state==='csi'){if(code>=0x40&&code<=0x7e)state='normal';}
   else if(state==='osc'||state==='string'){if((state==='osc'&&c==='\x07')||code===0x9c)state='normal';}
   if(code===0x18||code===0x1a)state='normal';
   if(state==='normal')safe=i+1;
  }
  this.pending=text.slice(safe);if(this.pending.length>128*1024){this.pending='';throw Error('终端控制序列超过缓冲限制，需要重新连接');}
  const complete=text.slice(0,safe);if(complete)await new Promise<void>(resolve=>this.term.write(complete,resolve));return complete;
 }
  snapshot(){return this.serializer.serialize({scrollback:3000});}
  checkpointReady(){return this.pending.length===0}
 close(){this.term.dispose();}
}
