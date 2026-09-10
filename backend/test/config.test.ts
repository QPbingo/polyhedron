import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {completeMasterKeyMigration,loadConfig,loadConnectorConfig,writePrivateJson} from '../src/host/config.js';
import {JOURNAL_HEALTHY} from '../src/adapters/keychain.js';

test('master-key provisioning is serialized, crash-safe and excluded from Connector memory',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'poly-config-')),path=join(dir,'host.json'),hostToken='host-token-with-more-than-thirty-two-characters',secrets=new Map([['com.polyhedron.host:host-a',hostToken]]),reads:string[]=[];mkdirSync(join(dir,'root'));writePrivateJson(path,{hostId:'host-a',accountId:'account-a',hostTokenKeychain:{service:'com.polyhedron.host',account:'host-a'},ipcToken:'ipc-token-with-more-than-thirty-two-characters',relayUrl:'wss://relay.example/ws/host',name:'Mac',roots:[join(dir,'root')]});
 const deps={platform:'darwin',randomSecret:()=>`master-${'x'.repeat(40)}`,readSecret:async(service:string,account:string)=>{reads.push(service);const value=secrets.get(`${service}:${account}`);if(!value)throw new Error('missing');return value},storeSecret:async(service:string,account:string,value:string)=>{secrets.set(`${service}:${account}`,value)}};
 try{
  await assert.rejects(loadConfig(path,{...deps,writeOptions:{beforeRename(){throw new Error('power loss before provisioning rename')}}}),/power loss/);assert.equal((JSON.parse(readFileSync(path,'utf8')) as any).masterKeyKeychain,undefined);const provisioned=secrets.get('com.polyhedron.master:host-a');assert.ok(provisioned);
  const [first,second]=await Promise.all([loadConfig(path,deps),loadConfig(path,deps)]);assert.equal(first.masterKey,provisioned);assert.equal(second.masterKey,provisioned);assert.equal(secrets.get('com.polyhedron.health:host-a'),JOURNAL_HEALTHY);const persisted=JSON.parse(readFileSync(path,'utf8'));assert.equal(persisted.masterKey,undefined);assert.equal(persisted.masterKeyMigration,'hostToken-v1');
  reads.length=0;const connector=await loadConnectorConfig(path,deps);assert.equal(connector.hostToken,hostToken);assert.deepEqual(reads,['com.polyhedron.host']);assert.equal('masterKey' in connector,false);assert.equal('journalFailureLatched' in connector,false);
  assert.throws(()=>completeMasterKeyMigration(path,{beforeRename(){throw new Error('power loss before completion rename')}}),/power loss/);assert.equal(JSON.parse(readFileSync(path,'utf8')).masterKeyMigration,'hostToken-v1');completeMasterKeyMigration(path);assert.equal(JSON.parse(readFileSync(path,'utf8')).masterKeyMigration,undefined);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
