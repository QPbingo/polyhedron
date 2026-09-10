import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOutput, OffsetCursor, inputAllowed } from '../src/protocol.ts';

test('binary metadata length counts UTF8 bytes and rejects malformed offset output', () => {
 const data = new TextEncoder().encode('你好\x1b[31m');
 const meta = new TextEncoder().encode(JSON.stringify({type:'event',event:'journal',kind:'pty_output',hostId:'h',sessionId:'会话',clientId:'c',runtimeOffset:1,offset:2,dataBytes:data.length}));
 const wire = new Uint8Array(4+meta.length+data.length);
 new DataView(wire.buffer).setUint32(0,meta.length); wire.set(meta,4); wire.set(data,4+meta.length);
 assert.equal(decodeOutput(wire.buffer).data,'你好\x1b[31m');
 assert.throws(()=>decodeOutput(new Uint8Array([0,0,0,90]).buffer));
 assert.throws(()=>decodeOutput(new ArrayBuffer(8*1024*1024+1)),/8 MiB/);
});
test('offset cursor discards snapshot duplicates, advances facts and rejects gaps', () => {
 const cursor = new OffsetCursor();
 assert.deepEqual(cursor.push({offset:4,runtimeOffset:1,kind:'pty_output',data:'old'}),[]);
 cursor.push({offset:6,runtimeOffset:1,kind:'pty_output',data:'b'});cursor.push({offset:5,runtimeOffset:1,kind:'pty_output',data:'a'});
 assert.deepEqual(cursor.installSnapshot(4,1).map(x=>x.data),['a','b']);
 assert.deepEqual(cursor.push({offset:6,runtimeOffset:1,kind:'pty_output',data:'duplicate'}),[]);
 assert.deepEqual(cursor.push({offset:7,runtimeOffset:1,kind:'agent_state_changed'}).map(x=>x.offset),[7]);
 assert.throws(()=>cursor.push({offset:9,runtimeOffset:1,kind:'pty_output',data:'gap'}),/OFFSET_GAP/);
});
test('input requires online connection, rendered snapshot, confirmed resize and current ownership', () => {
 const ready={online:true,snapshot:true,resized:true,controller:'me',clientId:'me',running:true};
 assert.equal(inputAllowed(ready),true);
 for(const key of ['online','snapshot','resized','running']) assert.equal(inputAllowed({...ready,[key]:false}),false);
 assert.equal(inputAllowed({...ready,controller:'other'}),false);
});

test('pre-snapshot output queue limits encoded UTF8 bytes',()=>{
 const cursor=new OffsetCursor();cursor.push({runtimeOffset:1,offset:1,kind:'pty_output',data:'你'.repeat(600000)});
 assert.throws(()=>cursor.push({runtimeOffset:1,offset:2,kind:'pty_output',data:'你'.repeat(100000)}),/overflow/);
});
