import test from 'node:test';
import assert from 'node:assert/strict';
import {SecureChannel,type FingerprintStore} from '../src/secureChannel.ts';
import {accept,testIdentity} from './channel-fixture.ts';

class Pins implements FingerprintStore{values=new Map<string,string>();get(hostId:string){return this.values.get(hostId)??null}set(hostId:string,value:string){this.values.set(hostId,value)}}

test('secure channel requires explicit first trust, then interoperates and blocks changed fingerprints',async()=>{
    const identity=testIdentity(),pins=new Pins();
    const browser=await SecureChannel.begin('host-a','channel-a',pins);const host=accept(identity,browser.hello);
    await assert.rejects(browser.complete(host.hello),(error:any)=>error.code==='HOST_TRUST_REQUIRED'&&error.fingerprint===host.hello.fingerprint);assert.equal(pins.get('host-a'),null);pins.set('host-a',host.hello.fingerprint);
    const trusted=await SecureChannel.begin('host-a','channel-trusted',pins),trustedHost=accept(identity,trusted.hello);await trusted.complete(trustedHost.hello);
    const request=await trusted.seal({method:'input',params:{data:'PRIVATE_BROWSER_PROMPT'}});assert.equal(JSON.stringify(request).includes('PRIVATE_BROWSER_PROMPT'),false);assert.deepEqual(trustedHost.channel.open(request),{method:'input',params:{data:'PRIVATE_BROWSER_PROMPT'}});
    const concurrent=await Promise.all(Array.from({length:32},(_,index)=>trusted.seal({index})));assert.deepEqual(concurrent.map(frame=>frame.nonce),Array.from({length:32},(_,index)=>index+2));for(let index=0;index<concurrent.length;index++)assert.deepEqual(trustedHost.channel.open(concurrent[index]),{index});
    assert.deepEqual(await trusted.open(trustedHost.channel.seal({result:'PRIVATE_HOST_OUTPUT'})),{result:'PRIVATE_HOST_OUTPUT'});
    pins.set('host-a','changed-fingerprint');const changed=await SecureChannel.begin('host-a','channel-b',pins);const changedHost=accept(identity,changed.hello);
    await assert.rejects(changed.complete(changedHost.hello),(error:any)=>error.code==='HOST_IDENTITY_CHANGED');
});
