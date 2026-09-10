import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OffsetCursor, inputAllowed } from '../src/protocol.ts';
test('offset cursor discards snapshot duplicates, advances facts and rejects gaps', () => {
 const cursor = new OffsetCursor();
 assert.deepEqual(cursor.push({offset:4,runtimeOffset:1,kind:'pty_output',data:'old'}),[]);
 cursor.push({offset:6,runtimeOffset:1,kind:'pty_output',data:'b'});cursor.push({offset:5,runtimeOffset:1,kind:'pty_output',data:'a'});
 assert.deepEqual(cursor.installSnapshot(4,1).map(x=>x.data),['a','b']);
 assert.deepEqual(cursor.push({offset:6,runtimeOffset:1,kind:'pty_output',data:'duplicate'}),[]);
 assert.deepEqual(cursor.push({offset:7,runtimeOffset:1,kind:'agent_state_changed'}).map(x=>x.offset),[7]);
 assert.throws(()=>cursor.push({offset:9,runtimeOffset:1,kind:'pty_output',data:'gap'}),/OFFSET_GAP/);
});
test('offset cursor rejects a new runtime until a fresh snapshot is installed', () => {
 const cursor = new OffsetCursor();
 cursor.installSnapshot(8,2);
 assert.throws(()=>cursor.push({offset:9,runtimeOffset:3,kind:'pty_output',data:'new process'}),/RUNTIME_CHANGED/);
 assert.deepEqual(cursor.push({offset:8,runtimeOffset:1,kind:'pty_output',data:'old duplicate'}),[]);
});
test('input requires online connection, rendered snapshot, confirmed resize and current ownership', () => {
 const ready={online:true,snapshot:true,resized:true,controller:'channel',channelId:'channel',running:true,journalReady:true};
 assert.equal(inputAllowed(ready),true);
 for(const key of ['online','snapshot','resized','running','journalReady']) assert.equal(inputAllowed({...ready,[key]:false}),false);
 assert.equal(inputAllowed({...ready,controller:'other'}),false);
 assert.equal(inputAllowed({...ready,channelId:null}),false);
});

test('pre-snapshot output queue limits encoded UTF8 bytes',()=>{
 const cursor=new OffsetCursor();cursor.push({runtimeOffset:1,offset:1,kind:'pty_output',data:'你'.repeat(600000)});
 assert.throws(()=>cursor.push({runtimeOffset:1,offset:2,kind:'pty_output',data:'你'.repeat(100000)}),/overflow/);
});
