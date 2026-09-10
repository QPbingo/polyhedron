import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFrame,decodeFrame} from '../src/shared/wire.js';

test('offset binary journal output round trips and rejects legacy or malformed metadata',()=>{
  const event={type:'event',event:'journal',kind:'pty_output',hostId:'host',sessionId:'会话',clientId:'client',offset:7,runtimeOffset:2,data:'你好\x1b[31m'};
  const frame=encodeFrame(event);
  assert.ok(Buffer.isBuffer(frame));
  assert.deepEqual(decodeFrame(frame as Buffer,true),event);

  const legacyMeta=Buffer.from(JSON.stringify({type:'event',event:'output',hostId:'host',sessionId:'s',clientId:'c',runtimeEpoch:'r',seq:1}));
  const legacySize=Buffer.alloc(4);legacySize.writeUInt32BE(legacyMeta.length);
  assert.throws(()=>decodeFrame(Buffer.concat([legacySize,legacyMeta,Buffer.from('legacy')]),true),/offset|binary/i);

  const invalidMeta=Buffer.from(JSON.stringify({...event,offset:-1,data:undefined}));
  const invalidSize=Buffer.alloc(4);invalidSize.writeUInt32BE(invalidMeta.length);
  assert.throws(()=>decodeFrame(Buffer.concat([invalidSize,invalidMeta,Buffer.from('x')]),true),/offset|binary/i);
  assert.throws(()=>decodeFrame(Buffer.alloc(8*1024*1024+1),true),/limit/i);
});

