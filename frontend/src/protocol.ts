import type {JournalEvent} from './types.ts';
type OffsetItem=Pick<JournalEvent,'offset'|'runtimeOffset'|'kind'|'data'|'session'>;
export class OffsetCursor {
  appliedOffset:number|null=null;runtimeOffset:number|null=null;pending:OffsetItem[]=[];bytes=0;
  push(item:OffsetItem):OffsetItem[]{
    if(this.appliedOffset===null){this.bytes+=item.data?new TextEncoder().encode(item.data).byteLength:0;if(this.bytes>2*1024*1024)throw new Error('Output queue overflow');this.pending.push(item);return []}
    if(item.offset<=this.appliedOffset)return [];
    if(item.runtimeOffset!==this.runtimeOffset)throw new Error('RUNTIME_CHANGED');
    if(item.offset!==this.appliedOffset+1)throw new Error('OFFSET_GAP');
    this.appliedOffset=item.offset;this.runtimeOffset=item.runtimeOffset;return [item];
  }
  installSnapshot(baseOffset:number,runtimeOffset:number):OffsetItem[]{
    if(!Number.isSafeInteger(baseOffset)||baseOffset<0||!Number.isSafeInteger(runtimeOffset)||runtimeOffset<1)throw new Error('Invalid snapshot offset');
    this.appliedOffset=baseOffset;this.runtimeOffset=runtimeOffset;const list=this.pending.sort((a,b)=>a.offset-b.offset);this.pending=[];this.bytes=0;return list.flatMap(item=>this.push(item));
  }
}
export function inputAllowed(input:{online:boolean;snapshot:boolean;resized:boolean;controller:string|null;channelId:string|null;running:boolean;journalReady:boolean}){return input.online&&input.snapshot&&input.resized&&input.running&&input.journalReady&&!!input.channelId&&input.controller===input.channelId}
