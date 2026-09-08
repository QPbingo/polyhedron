import type { Output } from './types.ts';
export function decodeOutput(buffer:ArrayBuffer):Output {
 if(buffer.byteLength>8*1024*1024)throw new Error('Output frame exceeds 8 MiB');
 if(buffer.byteLength<4)throw new Error('Invalid output frame');
 const n=new DataView(buffer).getUint32(0); if(n<2||n>65536||n+4>buffer.byteLength)throw new Error('Invalid metadata length');
 const decoder=new TextDecoder('utf-8',{fatal:true}); const meta=JSON.parse(decoder.decode(new Uint8Array(buffer,4,n)));
 if(meta.type!=='event'||meta.event!=='output'||!Number.isSafeInteger(meta.seq)||meta.seq<0||['hostId','sessionId','clientId','runtimeEpoch'].some(k=>typeof meta[k]!=='string'))throw new Error('Invalid output metadata');
 return {...meta,data:decoder.decode(new Uint8Array(buffer,4+n))};
}
type Chunk = Pick<Output,'runtimeEpoch'|'seq'|'data'>;
export class OutputCursor {
 epoch:string; seq:number|null=null; pending:Chunk[]=[]; bytes=0;
 constructor(epoch:string){this.epoch=epoch}
 push(item:Chunk):Chunk[]{
  if(item.runtimeEpoch!==this.epoch)return [];
  if(this.seq===null){this.bytes+=new TextEncoder().encode(item.data).byteLength;if(this.bytes>2*1024*1024)throw new Error('Output queue overflow');this.pending.push(item);return []}
  if(item.seq<=this.seq)return [];
  if(item.seq!==this.seq+1)throw new Error('Output sequence gap');
  this.seq=item.seq;return [item];
 }
 snapshot(seq:number):Chunk[]{this.seq=seq;const list=this.pending.sort((a,b)=>a.seq-b.seq);this.pending=[];this.bytes=0;return list.flatMap(item=>this.push(item))}
}
export function inputAllowed(x:{online:boolean;snapshot:boolean;resized:boolean;controller:string|null;clientId:string;running:boolean}):boolean{return x.online&&x.snapshot&&x.resized&&x.running&&x.controller===x.clientId}
