import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,createHash,createPublicKey,hkdfSync,verify} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HostChannel,HostIdentity,channelTranscript,type SealedFrame} from '../src/host/channel.js';

const b64=(value:Uint8Array)=>Buffer.from(value).toString('base64url');

test('end-to-end channel derives matching keys, authenticates Host identity and rejects replay or tampering',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'poly-channel-'));
  try{
    const identity=HostIdentity.loadOrCreate({dataDir:dir,hostId:'host-a',secret:'host-secret-with-at-least-thirty-two-characters'});
    const client=createECDH('prime256v1');client.generateKeys();const channelId='channel-a';
    const accepted=HostChannel.accept(identity,{v:1,hostId:'host-a',channelId,clientPublicKey:b64(client.getPublicKey())});
    const transcript=channelTranscript({hostId:'host-a',channelId,clientPublicKey:b64(client.getPublicKey()),hostPublicKey:accepted.hello.hostPublicKey,hostEphemeralPublicKey:accepted.hello.hostEphemeralPublicKey});
    assert.equal(verify(null,Buffer.from(transcript),createPublicKey({key:Buffer.from(accepted.hello.hostPublicKey,'base64url'),format:'der',type:'spki'}),Buffer.from(accepted.hello.signature,'base64url')),true);
    assert.equal(accepted.hello.fingerprint,b64(createHash('sha256').update(Buffer.from(accepted.hello.hostPublicKey,'base64url')).digest()));
    const secret=client.computeSecret(Buffer.from(accepted.hello.hostEphemeralPublicKey,'base64url'));
    const keys=Buffer.from(hkdfSync('sha256',secret,Buffer.from(channelId),Buffer.from('polyhedron-channel-v1'),64));
    const clientChannel=HostChannel.forTest(channelId,keys.subarray(0,32),keys.subarray(32));
    const sentinel={method:'input',params:{data:'SENTINEL_PROMPT'}};
    const request=clientChannel.seal(sentinel);assert.equal(JSON.stringify(request).includes('SENTINEL_PROMPT'),false);assert.deepEqual(accepted.channel.open(request),sentinel);
    await assert.rejects(async()=>accepted.channel.open(request),/nonce|replay/i);
    const response=accepted.channel.seal({ok:true,value:'SENTINEL_OUTPUT'});assert.deepEqual(clientChannel.open(response),{ok:true,value:'SENTINEL_OUTPUT'});
    const tampered:SealedFrame={...accepted.channel.seal({ok:true}),ciphertext:accepted.channel.seal({other:true}).ciphertext};
    await assert.rejects(async()=>clientChannel.open(tampered),/auth|decrypt|nonce/i);
    const fresh=HostChannel.forTest('channel-b',keys.subarray(0,32),keys.subarray(32));
    await assert.rejects(async()=>fresh.open(accepted.channel.seal({secret:true})),/auth|decrypt|nonce/i);
    assert.equal(readFileSync(join(dir,'host-identity.json'),'utf8').includes('PRIVATE KEY'),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Host identity rekey remains recoverable across atomic-write crash boundaries',()=>{const dir=mkdtempSync(join(tmpdir(),'poly-identity-rekey-')),legacy='legacy-identity-secret-with-thirty-two-characters',secret='new-identity-secret-with-thirty-two-characters';try{const original=HostIdentity.loadOrCreate({dataDir:dir,hostId:'host-a',secret:legacy});assert.throws(()=>HostIdentity.loadOrCreate({dataDir:dir,hostId:'host-a',secret,legacySecret:legacy,writeOptions:{beforeRename(){throw new Error('before rename')}}}),/before rename/);const migrated=HostIdentity.loadOrCreate({dataDir:dir,hostId:'host-a',secret,legacySecret:legacy});assert.equal(migrated.publicKey,original.publicKey);assert.throws(()=>HostIdentity.loadOrCreate({dataDir:dir,hostId:'host-a',secret:'third-identity-secret-with-thirty-two-characters',legacySecret:secret,writeOptions:{afterRename(){throw new Error('after rename')}}}),/after rename/);const recovered=HostIdentity.loadOrCreate({dataDir:dir,hostId:'host-a',secret:'third-identity-secret-with-thirty-two-characters',legacySecret:secret});assert.equal(recovered.publicKey,original.publicKey)}finally{rmSync(dir,{recursive:true,force:true})}});
