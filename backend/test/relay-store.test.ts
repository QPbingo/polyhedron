import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {RelayStore,digest} from '../src/relay/store.js';

test('sessions and host bindings survive restart without persisting raw credentials',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-store-')),databasePath=join(dir,'relay.sqlite'),encryptionSecret='persist-secret-abcdefghijklmnopqrstuvwxyz';
  let store=new RelayStore({databasePath,encryptionSecret});
  try{
    await store.init();await store.upsertAccount({id:'account-a',issuer:'dev',subject:'a',name:'Alice'});
    const token=await store.createSession('account-a',60_000),hostToken='sensitive-host-token-abcdefghijklmnopqrstuvwxyz';
    await store.upsertHost({id:'host-a',accountId:'account-a',name:'Mac',hostToken});
    await store.saveOidcFlow('flow-id',{verifier:'pkce-secret-value',state:'state',nonce:'nonce'},60_000);
    await store.close();
    for(const path of readdirSync(dir)){const bytes=readFileSync(join(dir,path));for(const raw of [token,hostToken,'pkce-secret-value'])assert.equal(bytes.includes(Buffer.from(raw)),false,`${raw} must not be stored verbatim`);}
    const db=new DatabaseSync(databasePath,{readOnly:true});assert.equal((db.prepare('SELECT id_hash FROM browser_sessions').get() as any).id_hash,digest(token));db.close();
    store=new RelayStore({databasePath,encryptionSecret});await store.init();
    assert.equal((await store.getSession(token))?.accountId,'account-a');assert.equal((await store.getHost('host-a'))?.hostToken,hostToken);
    assert.equal((await store.consumeOidcFlow('flow-id'))?.verifier,'pkce-secret-value');assert.equal(await store.consumeOidcFlow('flow-id'),null);
    await store.revokeSession(digest(token));await store.close();store=new RelayStore({databasePath,encryptionSecret});await store.init();assert.equal(await store.getSession(token),null);
  }finally{await store.close();rmSync(dir,{recursive:true,force:true});}
});

test('concurrent pairing approval and polling issue exactly one owned host credential',async()=>{
  const store=new RelayStore({databasePath:':memory:',encryptionSecret:'test-encryption-secret-abcdefghijklmnopqrstuvwxyz'});await store.init();
  try{
    await store.upsertAccount({id:'a',issuer:'dev',subject:'a',name:'A'});await store.upsertAccount({id:'b',issuer:'dev',subject:'b',name:'B'});
    const p=await store.startPairing('Mac',60_000);
    const approvals=await Promise.allSettled([store.approvePairing(p.code,'a'),store.approvePairing(p.code,'b')]);assert.equal(approvals.filter(x=>x.status==='fulfilled').length,1);
    const polls=await Promise.allSettled([store.pollPairing(p.pairingId,p.pollToken),store.pollPairing(p.pairingId,p.pollToken)]);assert.equal(polls.filter(x=>x.status==='fulfilled').length,1);
    const result=(polls.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<any>).value;assert.equal(result.accountId,'a');
    await assert.rejects(store.upsertHost({id:result.hostId,accountId:'b',name:'Hijacked',hostToken:'attacker-token'}),/another account/);
    assert.equal((await store.getHost(result.hostId))?.accountId,'a');
  }finally{await store.close();}
});
