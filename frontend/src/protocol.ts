import type { JournalEvent,Output } from './types.ts';
export function decodeOutput(buffer:ArrayBuffer):JournalEvent {
 if(buffer.byteLength>8*1024*1024)throw new Error('Output frame exceeds 8 MiB');
 if(buffer.byteLength<4)throw new Error('Invalid output frame');
 const n=new DataView(buffer).getUint32(0); if(n<2||n>65536||n+4>buffer.byteLength)throw new Error('Invalid metadata length');
 const decoder=new TextDecoder('utf-8',{fatal:true}); const meta=JSON.parse(decoder.decode(new Uint8Array(buffer,4,n)));
 const body=new Uint8Array(buffer,4+n);
 if(meta.type!=='event'||meta.event!=='journal'||meta.kind!=='pty_output'||!Number.isSafeInteger(meta.offset)||meta.offset<1||!Number.isSafeInteger(meta.runtimeOffset)||meta.runtimeOffset<1||!Number.isSafeInteger(meta.dataBytes)||meta.dataBytes!==body.byteLength||['hostId','sessionId','clientId'].some(k=>typeof meta[k]!=='string'))throw new Error('Invalid output metadata');
 delete meta.dataBytes;return {...meta,data:decoder.decode(body)};
}
type OffsetItem=Pick<JournalEvent,'offset'|'runtimeOffset'|'kind'|'data'>;
export class OffsetCursor {
 appliedOffset:number|null=null;runtimeOffset:number|null=null;pending:OffsetItem[]=[];bytes=0;
 push(item:OffsetItem):OffsetItem[]{
  if(this.appliedOffset===null){this.bytes+=item.data?new TextEncoder().encode(item.data).byteLength:0;if(this.bytes>2*1024*1024)throw new Error('Output queue overflow');this.pending.push(item);return []}
  if(item.offset<=this.appliedOffset)return [];
  if(item.offset!==this.appliedOffset+1)throw new Error('OFFSET_GAP');
  this.appliedOffset=item.offset;this.runtimeOffset=item.runtimeOffset;return [item];
 }
 installSnapshot(baseOffset:number,runtimeOffset:number):OffsetItem[]{
  if(!Number.isSafeInteger(baseOffset)||baseOffset<0||!Number.isSafeInteger(runtimeOffset)||runtimeOffset<1)throw new Error('Invalid snapshot offset');
  this.appliedOffset=baseOffset;this.runtimeOffset=runtimeOffset;const list=this.pending.sort((a,b)=>a.offset-b.offset);this.pending=[];this.bytes=0;return list.flatMap(item=>this.push(item));
 }
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
