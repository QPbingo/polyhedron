import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostStore} from '../src/host/store.js';

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

test('event-chain corruption fails closed instead of returning modified history',()=>{
  const {options}=setup();let store=new HostStore(options);
  store.journal.appendFact({streamId:'session:s1',kind:'pty_output',runtimeOffset:1,payload:{data:'original'}});
  store.db.prepare("UPDATE journal_events SET event_hash='broken' WHERE stream_id='session:s1' AND offset=1").run();
  store.close();
  assert.throws(()=>new HostStore(options),/integrity|完整性/i);
});

