import type {DatabaseSync} from 'node:sqlite';
import {Fault} from '../shared/types.js';
import {LocalCipher,stableJson} from './crypto.js';

export type JournalFaultPoint='request.beforeCommit'|'request.afterCommit'|'result.beforeCommit'|'result.afterCommit'|'fact.beforeCommit'|'fact.afterCommit';
export interface JournalFaults{hit(point:JournalFaultPoint):void}
export interface StoredJournalEvent{streamId:string;offset:number;kind:string;operationId:string|null;actor:string|null;at:string;runtimeOffset:number;payload:unknown}
export interface OperationRecord{status:'requested'|'applied'|'failed'|'indeterminate';requestOffset:number;resultOffset:number|null;result?:unknown;error?:{code:string;message:string}}
export interface OperationHandle{streamId:string;operationId:string;actor:string;kind:string;payloadDigest:string;requestOffset:number}
type BeginInput={streamId:string;operationId:string;actor:string;kind:string;payload:unknown;runtimeOffset?:number;at?:string};
type CompleteInput={kind:string;result?:unknown;resultFactory?:(event:StoredJournalEvent)=>unknown;error?:{code:string;message:string};payload?:unknown;runtimeOffset?:number;status?:'applied'|'failed'|'indeterminate';at?:string;mutate?:(db:DatabaseSync,event:StoredJournalEvent)=>void};
type FactInput={streamId:string;kind:string;payload:unknown;runtimeOffset?:number;operationId?:string;actor?:string;at?:string;mutate?:(db:DatabaseSync,event:StoredJournalEvent)=>void};

export class HostJournal{
  constructor(readonly db:DatabaseSync,readonly cipher:LocalCipher,private faults?:JournalFaults){this.schema();this.verify();this.recover()}
  private schema(){this.db.exec(`
    CREATE TABLE IF NOT EXISTS journal_streams(stream_id TEXT PRIMARY KEY,head_offset INTEGER NOT NULL DEFAULT 0,head_hash TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS session_keys(stream_id TEXT PRIMARY KEY REFERENCES journal_streams(stream_id) ON DELETE CASCADE,key_cipher TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS journal_events(stream_id TEXT NOT NULL REFERENCES journal_streams(stream_id) ON DELETE CASCADE,offset INTEGER NOT NULL,kind TEXT NOT NULL,operation_id TEXT,actor TEXT,at TEXT NOT NULL,runtime_offset INTEGER NOT NULL DEFAULT 0,payload_cipher TEXT NOT NULL,payload_digest TEXT NOT NULL,prev_hash TEXT NOT NULL,event_hash TEXT NOT NULL,PRIMARY KEY(stream_id,offset));
    CREATE INDEX IF NOT EXISTS journal_events_operation_idx ON journal_events(stream_id,operation_id);
    CREATE TABLE IF NOT EXISTS journal_operations(stream_id TEXT NOT NULL,actor TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,payload_digest TEXT NOT NULL,status TEXT NOT NULL,request_offset INTEGER NOT NULL,result_offset INTEGER,result_cipher TEXT,error_code TEXT,error_message TEXT,PRIMARY KEY(stream_id,actor,operation_id));
    CREATE TABLE IF NOT EXISTS legacy_imports(source TEXT PRIMARY KEY,checksum TEXT NOT NULL,imported_at TEXT NOT NULL);
  `)}
  private transaction<T>(work:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result}catch(error){try{this.db.exec('ROLLBACK')}catch{}throw error}}
  private key(streamId:string){
    let stream=this.db.prepare('SELECT head_offset,head_hash FROM journal_streams WHERE stream_id=?').get(streamId) as any;
    if(!stream){this.db.prepare("INSERT INTO journal_streams(stream_id,head_offset,head_hash) VALUES (?,0,'')").run(streamId);const key=this.cipher.randomKey();this.db.prepare('INSERT INTO session_keys(stream_id,key_cipher) VALUES (?,?)').run(streamId,this.cipher.wrapKey(key,streamId));return key}
    const row=this.db.prepare('SELECT key_cipher FROM session_keys WHERE stream_id=?').get(streamId) as any;if(!row)throw new Fault('INTEGRITY_CHECK_FAILED','Journal stream key is missing');return this.cipher.unwrapKey(row.key_cipher,streamId);
  }
  private appendWithin(input:FactInput):StoredJournalEvent{
    const key=this.key(input.streamId),head=this.db.prepare('SELECT head_offset,head_hash FROM journal_streams WHERE stream_id=?').get(input.streamId) as any;
    const offset=Number(head.head_offset)+1,at=input.at??new Date().toISOString(),runtimeOffset=input.runtimeOffset??(input.kind==='runtime_started'?offset:0),payloadDigest=this.cipher.digest(stableJson(input.payload));
    const payloadCipher=this.cipher.sealJson(input.payload,key,`event:${input.streamId}:${offset}:${input.kind}`),prevHash=String(head.head_hash??'');
    const signed=stableJson({streamId:input.streamId,offset,kind:input.kind,operationId:input.operationId??null,actor:input.actor??null,at,runtimeOffset,payloadDigest,prevHash,payloadCipher});
    const eventHash=this.cipher.eventHash(key,signed);
    this.db.prepare('INSERT INTO journal_events(stream_id,offset,kind,operation_id,actor,at,runtime_offset,payload_cipher,payload_digest,prev_hash,event_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(input.streamId,offset,input.kind,input.operationId??null,input.actor??null,at,runtimeOffset,payloadCipher,payloadDigest,prevHash,eventHash);
    this.db.prepare('UPDATE journal_streams SET head_offset=?,head_hash=? WHERE stream_id=?').run(offset,eventHash,input.streamId);
    const event={streamId:input.streamId,offset,kind:input.kind,operationId:input.operationId??null,actor:input.actor??null,at,runtimeOffset,payload:input.payload};input.mutate?.(this.db,event);return event;
  }
  begin(input:BeginInput):{handle?:OperationHandle;duplicate?:OperationRecord}{
    if(!input.operationId||input.operationId.length>200)throw new Fault('INVALID_OPERATION','Operation ID is invalid');
    const payloadDigest=this.cipher.digest(stableJson(input.payload));
    const existing=this.db.prepare('SELECT * FROM journal_operations WHERE stream_id=? AND actor=? AND operation_id=?').get(input.streamId,input.actor,input.operationId) as any;
    if(existing){if(existing.kind!==input.kind||existing.payload_digest!==payloadDigest)throw new Fault('OPERATION_COLLISION','Operation ID collision');return {duplicate:this.decodeOperation(existing)}}
    this.faults?.hit('request.beforeCommit');
    const handle=this.transaction(()=>{const event=this.appendWithin({streamId:input.streamId,kind:`${input.kind}_requested`,operationId:input.operationId,actor:input.actor,runtimeOffset:input.runtimeOffset,payload:input.payload,at:input.at});this.db.prepare("INSERT INTO journal_operations(stream_id,actor,operation_id,kind,payload_digest,status,request_offset) VALUES (?,?,?,?,?,'requested',?)").run(input.streamId,input.actor,input.operationId,input.kind,payloadDigest,event.offset);return {streamId:input.streamId,operationId:input.operationId,actor:input.actor,kind:input.kind,payloadDigest,requestOffset:event.offset}});
    this.faults?.hit('request.afterCommit');return {handle};
  }
  complete(handle:OperationHandle,input:CompleteInput):StoredJournalEvent{
    this.faults?.hit('result.beforeCommit');
    const event=this.transaction(()=>{const current=this.db.prepare('SELECT status FROM journal_operations WHERE stream_id=? AND actor=? AND operation_id=?').get(handle.streamId,handle.actor,handle.operationId) as any;if(!current||current.status!=='requested')throw new Fault('OPERATION_STATE','Operation is not pending');const status=input.status??(input.error?'failed':'applied');const payload=input.payload??(input.error?{error:input.error}:{result:input.result});const event=this.appendWithin({streamId:handle.streamId,kind:input.kind,operationId:handle.operationId,actor:handle.actor,runtimeOffset:input.runtimeOffset,payload,at:input.at,mutate:input.mutate});const result=input.resultFactory?input.resultFactory(event):input.result;const key=this.key(handle.streamId),resultCipher=result===undefined?null:this.cipher.sealJson(result,key,`operation:${handle.streamId}:${handle.actor}:${handle.operationId}`);this.db.prepare('UPDATE journal_operations SET status=?,result_offset=?,result_cipher=?,error_code=?,error_message=? WHERE stream_id=? AND actor=? AND operation_id=?').run(status,event.offset,resultCipher,input.error?.code??null,input.error?.message??null,handle.streamId,handle.actor,handle.operationId);return event});
    this.faults?.hit('result.afterCommit');return event;
  }
  appendFact(input:FactInput){this.faults?.hit('fact.beforeCommit');const event=this.transaction(()=>this.appendWithin(input));this.faults?.hit('fact.afterCommit');return event}
  eventsAfter(streamId:string,offset:number,limit=10000):StoredJournalEvent[]{
    const keyRow=this.db.prepare('SELECT key_cipher FROM session_keys WHERE stream_id=?').get(streamId) as any;if(!keyRow)return[];const key=this.cipher.unwrapKey(keyRow.key_cipher,streamId);
    return (this.db.prepare('SELECT * FROM journal_events WHERE stream_id=? AND offset>? ORDER BY offset LIMIT ?').all(streamId,offset,limit) as any[]).map(row=>({streamId:row.stream_id,offset:Number(row.offset),kind:row.kind,operationId:row.operation_id,actor:row.actor,at:row.at,runtimeOffset:Number(row.runtime_offset),payload:this.cipher.openJson(row.payload_cipher,key,`event:${streamId}:${row.offset}:${row.kind}`)}));
  }
  head(streamId:string){const row=this.db.prepare('SELECT head_offset FROM journal_streams WHERE stream_id=?').get(streamId) as any;return Number(row?.head_offset??0)}
  private decodeOperation(row:any):OperationRecord{let result:unknown;if(row.result_cipher){const key=this.key(row.stream_id);result=this.cipher.openJson(row.result_cipher,key,`operation:${row.stream_id}:${row.actor}:${row.operation_id}`)}return {status:row.status,requestOffset:Number(row.request_offset),resultOffset:row.result_offset===null?null:Number(row.result_offset),result,error:row.error_code?{code:row.error_code,message:row.error_message}:undefined}}
  recover(){const pending=this.db.prepare("SELECT * FROM journal_operations WHERE status='requested' ORDER BY stream_id,request_offset").all() as any[];for(const row of pending)this.transaction(()=>{const event=this.appendWithin({streamId:row.stream_id,kind:'operation_indeterminate',operationId:row.operation_id,actor:row.actor,payload:{operation:row.kind,reason:'host_restarted'}});this.db.prepare("UPDATE journal_operations SET status='indeterminate',result_offset=?,error_code='OPERATION_INDETERMINATE',error_message='Operation result is unknown after host restart' WHERE stream_id=? AND actor=? AND operation_id=?").run(event.offset,row.stream_id,row.actor,row.operation_id)})}
  verify(){
    const streams=this.db.prepare('SELECT * FROM journal_streams ORDER BY stream_id').all() as any[];
    for(const stream of streams){const key=this.key(stream.stream_id);let offset=0,previous='';for(const row of this.db.prepare('SELECT * FROM journal_events WHERE stream_id=? ORDER BY offset').all(stream.stream_id) as any[]){offset++;if(Number(row.offset)!==offset||row.prev_hash!==previous)throw new Fault('INTEGRITY_CHECK_FAILED','Journal offset chain failed integrity verification');const signed=stableJson({streamId:row.stream_id,offset:Number(row.offset),kind:row.kind,operationId:row.operation_id,actor:row.actor,at:row.at,runtimeOffset:Number(row.runtime_offset),payloadDigest:row.payload_digest,prevHash:row.prev_hash,payloadCipher:row.payload_cipher});const expected=this.cipher.eventHash(key,signed);if(!this.cipher.equal(expected,row.event_hash))throw new Fault('INTEGRITY_CHECK_FAILED','Journal event failed integrity verification');previous=row.event_hash}if(Number(stream.head_offset)!==offset||stream.head_hash!==previous)throw new Fault('INTEGRITY_CHECK_FAILED','Journal head failed integrity verification')}
  }
  importLegacy(source:string,checksum:string,entries:FactInput[]){if(this.db.prepare('SELECT 1 FROM legacy_imports WHERE source=?').get(source))return;this.transaction(()=>{for(const entry of entries)this.appendWithin(entry);this.db.prepare('INSERT INTO legacy_imports(source,checksum,imported_at) VALUES (?,?,?)').run(source,checksum,new Date().toISOString())})}
}
