import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutput, OutputCursor, inputAllowed } from '../src/protocol.ts';

test('binary metadata length counts UTF8 bytes and rejects malformed output', () => {
 const meta = new TextEncoder().encode(JSON.stringify({type:'event',event:'output',hostId:'h',sessionId:'会话',clientId:'c',runtimeEpoch:'r',seq:2}));
 const data = new TextEncoder().encode('你好\x1b[31m'); const wire = new Uint8Array(4+meta.length+data.length);
 new DataView(wire.buffer).setUint32(0,meta.length); wire.set(meta,4); wire.set(data,4+meta.length);
 assert.equal(decodeOutput(wire.buffer).data,'你好\x1b[31m');
 assert.throws(()=>decodeOutput(new Uint8Array([0,0,0,90]).buffer));
 assert.throws(()=>decodeOutput(new ArrayBuffer(8*1024*1024+1)),/8 MiB/);
});
test('atomic snapshot discards queued duplicate output and drains newer output in sequence', () => {
 const cursor = new OutputCursor('r');
 assert.deepEqual(cursor.push({runtimeEpoch:'r',seq:4,data:'old'}),[]);
 cursor.push({runtimeEpoch:'r',seq:6,data:'b'});cursor.push({runtimeEpoch:'r',seq:5,data:'a'});
 assert.deepEqual(cursor.snapshot(4).map(x=>x.data),['a','b']);
 assert.deepEqual(cursor.push({runtimeEpoch:'r',seq:6,data:'duplicate'}),[]);
 assert.deepEqual(cursor.push({runtimeEpoch:'old',seq:7,data:'stale'}),[]);
 assert.throws(()=>cursor.push({runtimeEpoch:'r',seq:8,data:'gap'}),/gap/);
});
test('input requires online connection, rendered snapshot, confirmed resize and current ownership', () => {
 const ready={online:true,snapshot:true,resized:true,controller:'me',clientId:'me',running:true};
 assert.equal(inputAllowed(ready),true);
 for(const key of ['online','snapshot','resized','running']) assert.equal(inputAllowed({...ready,[key]:false}),false);
 assert.equal(inputAllowed({...ready,controller:'other'}),false);
});

test('pre-snapshot output queue limits encoded UTF8 bytes',()=>{
 const cursor=new OutputCursor('r');cursor.push({runtimeEpoch:'r',seq:1,data:'你'.repeat(600000)});
 assert.throws(()=>cursor.push({runtimeEpoch:'r',seq:2,data:'你'.repeat(100000)}),/overflow/);
});
