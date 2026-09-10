import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,truncateSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {HostStore} from '../src/host/store.js';
import {stableJson} from '../src/host/crypto.js';
import type {JournalFaultPoint} from '../src/host/journal.js';

const dirs:string[]=[];
test.after(()=>dirs.forEach(dir=>rmSync(dir,{recursive:true,force:true})));
function setup(){const dir=mkdtempSync(join(tmpdir(),'poly-journal-'));dirs.push(dir);return {dir,options:{dir,secret:'host-secret-at-least-32-characters',hostId:'host-a'}};}

test('encrypted journal uses WAL FULL, contiguous offsets and durable idempotency',()=>{
  const {dir,options}=setup();let store=new HostStore(options);
  assert.equal((store.db.prepare('PRAGMA journal_mode').get() as any).journal_mode,'wal');
  assert.equal((store.db.prepare('PRAGMA synchronous').get() as any).synchronous,2);
  const begun=store.journal.begin({streamId:'session:s1',operationId:'op-1',actor:'client-a',kind:'input',payload:{bytes:10,digest:'secret-input-digest'}});
  assert.equal(begun.duplicate,undefined);
  const applied=store.journal.complete(begun.handle!,{kind:'input_applied',result:{accepted:true}});
  assert.equal(applied.offset,2);
  const fact=store.journal.appendFact({streamId:'session:s1',kind:'pty_output',runtimeOffset:2,payload:{data:'TOP SECRET OUTPUT'}});
  assert.equal(fact.offset,3);
  const duplicate=store.journal.begin({streamId:'session:s1',operationId:'op-1',actor:'client-a',kind:'input',payload:{bytes:10,digest:'secret-input-digest'}});
  assert.deepEqual(duplicate.duplicate?.result,{accepted:true});
  assert.equal(duplicate.duplicate?.status,'applied');
  assert.throws(()=>store.journal.begin({streamId:'session:s1',operationId:'op-1',actor:'client-a',kind:'resize',payload:{cols:80}}),/collision|冲突/i);
  store.close();
  const persisted=readdirSync(dir).filter(name=>name.startsWith('host.sqlite')).map(name=>readFileSync(join(dir,name)).toString('latin1')).join('');
  assert.doesNotMatch(persisted,/TOP SECRET OUTPUT|secret-input-digest/);
  store=new HostStore(options);
  assert.deepEqual(store.journal.eventsAfter('session:s1',0).map(event=>event.offset),[1,2,3]);
  assert.equal((store.journal.eventsAfter('session:s1',2)[0].payload as any).data,'TOP SECRET OUTPUT');
  store.close();
});

test('unfinished operation becomes indeterminate on restart and never becomes replayable',()=>{
  const {options}=setup();let store=new HostStore(options);
  store.journal.begin({streamId:'session:s1',operationId:'uncertain',actor:'client-a',kind:'terminate',payload:{confirm:true}});
  store.close();store=new HostStore(options);
  const duplicate=store.journal.begin({streamId:'session:s1',operationId:'uncertain',actor:'client-a',kind:'terminate',payload:{confirm:true}}).duplicate;
  assert.equal(duplicate?.status,'indeterminate');
  assert.equal(store.journal.eventsAfter('session:s1',0).at(-1)?.kind,'operation_indeterminate');
  store.close();
});

test('database-visible digests do not provide a plaintext candidate oracle',()=>{
  const {options}=setup(),store=new HostStore(options),payload={confirm:true};store.journal.begin({streamId:'session:s1',operationId:'low-entropy',actor:'client-a',kind:'terminate',payload});const event=store.db.prepare("SELECT payload_cipher,payload_digest FROM journal_events WHERE stream_id='session:s1' AND offset=1").get() as any,operation=store.db.prepare("SELECT payload_digest FROM journal_operations WHERE operation_id='low-entropy'").get() as any,plainDigest=createHash('sha256').update('{"confirm":true}').digest('hex');assert.equal(event.payload_digest,createHash('sha256').update(event.payload_cipher).digest('hex'));assert.notEqual(event.payload_digest,plainDigest);assert.notEqual(operation.payload_digest,plainDigest);store.close();
});

test('legacy plaintext-derived event and operation digests are rehashed and scrubbed',()=>{const {dir,options}=setup();let store=new HostStore(options),begun=store.journal.begin({streamId:'session:s1',operationId:'legacy-digest',actor:'client-a',kind:'terminate',payload:{confirm:true}});store.journal.complete(begun.handle!,{kind:'terminate_applied',result:{ok:true}});const keyRow=store.db.prepare("SELECT key_cipher FROM session_keys WHERE stream_id='session:s1'").get() as any,key=store.cipher.unwrapKey(keyRow.key_cipher,'session:s1'),events=store.journal.eventsAfter('session:s1',0);let previous='',requestDigest='';for(const event of events){const row=store.db.prepare('SELECT * FROM journal_events WHERE stream_id=? AND offset=?').get('session:s1',event.offset) as any,payloadDigest=store.cipher.digest(stableJson(event.payload)),signed=stableJson({streamId:row.stream_id,offset:Number(row.offset),kind:row.kind,operationId:row.operation_id,actor:row.actor,at:row.at,runtimeOffset:Number(row.runtime_offset),payloadDigest,prevHash:previous,payloadCipher:row.payload_cipher}),eventHash=store.cipher.eventHash(key,signed);store.db.prepare('UPDATE journal_events SET payload_digest=?,prev_hash=?,event_hash=? WHERE stream_id=? AND offset=?').run(payloadDigest,previous,eventHash,row.stream_id,row.offset);if(event.offset===1)requestDigest=payloadDigest;previous=eventHash}store.db.prepare("UPDATE journal_streams SET head_hash=? WHERE stream_id='session:s1'").run(previous);store.db.prepare("UPDATE journal_operations SET payload_digest=? WHERE operation_id='legacy-digest'").run(requestDigest);store.db.prepare("DELETE FROM journal_meta WHERE key IN ('event_digest_version','operation_digest_version')").run();store.close();store=new HostStore(options);const row=store.db.prepare("SELECT payload_cipher,payload_digest FROM journal_events WHERE stream_id='session:s1' AND offset=1").get() as any,operation=store.db.prepare("SELECT payload_digest FROM journal_operations WHERE operation_id='legacy-digest'").get() as any;assert.equal(row.payload_digest,createHash('sha256').update(row.payload_cipher).digest('hex'));assert.notEqual(operation.payload_digest,requestDigest);store.close();const persisted=readdirSync(dir).filter(name=>name.startsWith('host.sqlite')).map(name=>readFileSync(join(dir,name)).toString('latin1')).join('');assert.doesNotMatch(persisted,new RegExp(requestDigest))});

test('a crash after journal migration commit leaves a durable scrub obligation',()=>{
  const {dir,options}=setup();let store=new HostStore(options),begun=store.journal.begin({streamId:'session:s1',operationId:'crash-scrub',actor:'client-a',kind:'terminate',payload:{confirm:true}});store.journal.complete(begun.handle!,{kind:'terminate_applied',result:{ok:true}});
  const keyRow=store.db.prepare("SELECT key_cipher FROM session_keys WHERE stream_id='session:s1'").get() as any,key=store.cipher.unwrapKey(keyRow.key_cipher,'session:s1'),events=store.journal.eventsAfter('session:s1',0);let previous='',legacyDigest='';
  for(const event of events){const row=store.db.prepare('SELECT * FROM journal_events WHERE stream_id=? AND offset=?').get('session:s1',event.offset) as any,payloadDigest=store.cipher.digest(stableJson(event.payload)),signed=stableJson({streamId:row.stream_id,offset:Number(row.offset),kind:row.kind,operationId:row.operation_id,actor:row.actor,at:row.at,runtimeOffset:Number(row.runtime_offset),payloadDigest,prevHash:previous,payloadCipher:row.payload_cipher}),eventHash=store.cipher.eventHash(key,signed);store.db.prepare('UPDATE journal_events SET payload_digest=?,prev_hash=?,event_hash=? WHERE stream_id=? AND offset=?').run(payloadDigest,previous,eventHash,row.stream_id,row.offset);if(event.offset===1)legacyDigest=payloadDigest;previous=eventHash}store.db.prepare("UPDATE journal_streams SET head_hash=? WHERE stream_id='session:s1'").run(previous);store.db.prepare("UPDATE journal_operations SET payload_digest=? WHERE operation_id='crash-scrub'").run(legacyDigest);store.db.prepare("DELETE FROM journal_meta WHERE key IN ('event_digest_version','operation_digest_version')").run();store.close();
  const faults={point:'privacy.journalBeforeScrub' as JournalFaultPoint|null,hit(point:JournalFaultPoint){if(this.point===point){this.point=null;throw new Error(`injected ${point}`)}}};assert.throws(()=>new HostStore({...options,faults}),/privacy\.journalBeforeScrub/);
  let db=new DatabaseSync(join(dir,'host.sqlite'));assert.equal((db.prepare("SELECT value FROM journal_meta WHERE key='privacy_scrub_pending'").get() as any).value,'1');db.close();
  store=new HostStore(options);assert.equal(store.db.prepare("SELECT 1 FROM journal_meta WHERE key='privacy_scrub_pending'").get(),undefined);store.close();const persisted=readdirSync(dir).filter(name=>name.startsWith('host.sqlite')).map(name=>readFileSync(join(dir,name)).toString('latin1')).join('');assert.doesNotMatch(persisted,new RegExp(legacyDigest));
});

test('journal privacy scrub stays pending while a reader prevents WAL truncation',()=>{
  const {dir,options}=setup(),sentinel='PRIVATE_LEGACY_ERROR';let store=new HostStore(options),begun=store.journal.begin({streamId:'session:s1',operationId:'busy-scrub',actor:'client-a',kind:'launch',payload:{agent:'codex'}});store.journal.complete(begun.handle!,{kind:'operation_failed',status:'failed',error:{code:'LAUNCH_FAILED',message:sentinel}});store.db.prepare("UPDATE journal_operations SET error_message=?,error_cipher=NULL WHERE operation_id='busy-scrub'").run(sentinel);store.db.prepare("DELETE FROM journal_meta WHERE key='operation_error_version'").run();store.close();
  const reader=new DatabaseSync(join(dir,'host.sqlite'));reader.exec('BEGIN');reader.prepare("SELECT error_message FROM journal_operations WHERE operation_id='busy-scrub'").get();try{assert.throws(()=>new HostStore(options),/privacy|scrub|checkpoint|WAL|busy/i)}finally{reader.exec('ROLLBACK');reader.close()}
  let db=new DatabaseSync(join(dir,'host.sqlite'));assert.equal((db.prepare("SELECT value FROM journal_meta WHERE key='privacy_scrub_pending'").get() as any).value,'1');db.close();store=new HostStore(options);assert.equal(store.db.prepare("SELECT 1 FROM journal_meta WHERE key='privacy_scrub_pending'").get(),undefined);store.close();const persisted=readdirSync(dir).filter(name=>name.startsWith('host.sqlite')).map(name=>readFileSync(join(dir,name)).toString('latin1')).join('');assert.doesNotMatch(persisted,new RegExp(sentinel));
});

test('operation index deletion cannot make an authenticated side effect replayable',()=>{
  const {options}=setup();let store=new HostStore(options);const begun=store.journal.begin({streamId:'session:s1',operationId:'never-repeat',actor:'client-a',kind:'input',payload:{bytes:1,digest:'opaque'}});store.journal.complete(begun.handle!,{kind:'input_applied',result:{accepted:true}});store.db.prepare("DELETE FROM journal_operations WHERE operation_id='never-repeat'").run();store.close();assert.throws(()=>new HostStore(options),/integrity|幂等|index/i);
});

test('operation result removal or status rewriting fails closed against authenticated events',()=>{
  const first=setup(),applied=new HostStore(first.options),ok=applied.journal.begin({streamId:'session:s1',operationId:'applied',actor:'client-a',kind:'input',payload:{bytes:1}});applied.journal.complete(ok.handle!,{kind:'input_applied',result:{accepted:true}});applied.db.prepare("UPDATE journal_operations SET result_cipher=NULL WHERE operation_id='applied'").run();applied.close();assert.throws(()=>new HostStore(first.options),/integrity|result state/i);
  const second=setup(),failed=new HostStore(second.options),bad=failed.journal.begin({streamId:'session:s1',operationId:'failed',actor:'client-a',kind:'launch',payload:{agent:'codex'}});failed.journal.complete(bad.handle!,{kind:'operation_failed',status:'failed',error:{code:'LAUNCH_FAILED',message:'no executable'}});failed.db.prepare("UPDATE journal_operations SET status='applied',error_code=NULL,error_cipher=NULL WHERE operation_id='failed'").run();failed.close();assert.throws(()=>new HostStore(second.options),/integrity|result state/i);
});

test('operation failure details remain encrypted at rest',()=>{
  const {dir,options}=setup(),sentinel='PRIVATE_/Users/alice/secret-project';const store=new HostStore(options),begun=store.journal.begin({streamId:'session:s1',operationId:'failed-op',actor:'client-a',kind:'launch',payload:{agent:'codex'}});store.journal.complete(begun.handle!,{kind:'operation_failed',status:'failed',error:{code:'LAUNCH_FAILED',message:sentinel}});store.close();const persisted=readdirSync(dir).filter(name=>name.startsWith('host.sqlite')).map(name=>readFileSync(join(dir,name)).toString('latin1')).join('');assert.doesNotMatch(persisted,new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('event-chain corruption fails closed instead of returning modified history',()=>{
  const {options}=setup();let store=new HostStore(options);
  store.journal.appendFact({streamId:'session:s1',kind:'pty_output',runtimeOffset:1,payload:{data:'original'}});
  store.db.prepare("UPDATE journal_events SET event_hash='broken' WHERE stream_id='session:s1' AND offset=1").run();
  store.close();
  assert.throws(()=>new HostStore(options),/integrity|完整性/i);
});

test('an incorrect Host master key cannot decrypt or silently replace journal state',()=>{const {options}=setup();const store=new HostStore(options);store.journal.appendFact({streamId:'session:s1',kind:'pty_output',runtimeOffset:1,payload:{data:'secret'}});store.close();assert.throws(()=>new HostStore({...options,secret:'different-master-key-with-thirty-two-characters'}),/auth|decrypt|integrity/i)});

test('a truncated or corrupted health latch always fails closed',()=>{
  const {dir,options}=setup();let store=new HostStore(options),latch=join(dir,'journal-health.latch');store.close();truncateSync(latch,0);store=new HostStore(options);assert.equal(store.journalFailureLatched(),true);store.setJournalFailureLatch(false);store.close();store=new HostStore(options);assert.equal(store.journalFailureLatched(),false);store.close();writeFileSync(latch,Buffer.alloc(4096,88));store=new HostStore(options);assert.equal(store.journalFailureLatched(),true);store.close();
});
