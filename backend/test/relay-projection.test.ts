import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import WebSocket from 'ws';
import {createRelay} from '../src/relay/app.js';

const origin='http://127.0.0.1:18417';
async function login(app:any,name:string){const response=await app.inject({method:'POST',url:'/auth/dev',headers:{origin},payload:{name}});assert.equal(response.statusCode,200);return {cookie:String(response.headers['set-cookie']).split(';')[0],user:response.json().user};}
async function until(check:()=>Promise<boolean>){const end=Date.now()+2000;while(!await check()){if(Date.now()>end)throw new Error('timed out');await new Promise(resolve=>setTimeout(resolve,20));}}

test('relay stores no project, session, terminal or hook projection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-minimal-')),databasePath=join(dir,'relay.sqlite');
  const config={devAuth:true,bindHost:'127.0.0.1',publicOrigin:origin,sessionSecret:'projection-test-secret-abcdefghijklmnopqrstuvwxyz',databasePath};
  const sentinels=['/Users/private-author/secret-project','SENTINEL_SESSION_TITLE','SENTINEL_PROMPT','SENTINEL_TERMINAL_OUTPUT','SENTINEL_NATIVE_ID','SENTINEL_HOOK_BODY'];
  let app=await createRelay(config),host:WebSocket|undefined;
  try{
    const owner=await login(app,'alice'),foreign=await login(app,'bob'),hostToken='host-projection-token-abcdefghijklmnopqrstuvwxyz';
    await app.relayStore.upsertHost({id:'host-one',accountId:owner.user.id,name:'Mac',hostToken});
    const address=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');
    host=new WebSocket(`${address}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'host-one'}});await once(host,'open');
    host.send(JSON.stringify({type:'event',event:'state',hostId:'host-one',project:{path:sentinels[0]},session:{title:sentinels[1],input:sentinels[2],data:sentinels[3],nativeSessionId:sentinels[4],hookBody:sentinels[5]}}));
    const closed=once(host,'close');host.close();await closed;await until(async()=>(await app.inject({url:'/api/state',headers:{cookie:owner.cookie}})).json().hosts[0]?.online===false);
    assert.deepEqual((await app.inject({url:'/api/state',headers:{cookie:owner.cookie}})).json(),{hosts:[{id:'host-one',name:'Mac',online:false}],projects:[],sessions:[]});
    assert.deepEqual((await app.inject({url:'/api/state',headers:{cookie:foreign.cookie}})).json(),{hosts:[],projects:[],sessions:[]});
    await app.close();
    const db=new DatabaseSync(databasePath,{readOnly:true});
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row=>row.name);
    assert.equal(tables.includes('host_projections'),false);db.close();
    for(const file of readdirSync(dir)){const bytes=readFileSync(join(dir,file));for(const value of sentinels)assert.equal(bytes.includes(Buffer.from(value)),false,`Relay persisted ${value}`);}
    app=await createRelay(config);
    assert.deepEqual((await app.inject({url:'/api/state',headers:{cookie:owner.cookie}})).json(),{hosts:[{id:'host-one',name:'Mac',online:false}],projects:[],sessions:[]});
  }finally{host?.terminate();await app.close();rmSync(dir,{recursive:true,force:true});}
});
