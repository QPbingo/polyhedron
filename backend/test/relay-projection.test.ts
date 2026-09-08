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
async function login(app:any,name:string){const response=await app.inject({method:'POST',url:'/auth/dev',headers:{origin},payload:{name}});assert.equal(response.statusCode,200);return {cookie:String(response.headers['set-cookie']).split(';')[0],csrf:response.json().csrfToken,user:response.json().user};}
const project={id:'project-one',hostId:'host-one',name:'Workbench',path:'/Users/private-author/secret-project',createdAt:'2026-09-09T00:00:00.000Z'};
const session={id:'session-one',hostId:'host-one',projectId:'project-one',title:'Refactor',agent:'codex',processState:'running',activity:'working',runtimeEpoch:'runtime-one',controlEpoch:3,controller:'tab-secret',nativeSessionId:'native-secret-id-123',cols:100,rows:30,createdAt:project.createdAt,updatedAt:project.createdAt,archived:false,data:'private terminal transcript',input:'private prompt text',hookBody:{data:'private hook body'},warning:'/Users/private-author/private-error'};

test('offline host projection survives relay restart, excludes sensitive fields and stays account scoped',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-projection-')),databasePath=join(dir,'relay.sqlite');
  const config={devAuth:true,bindHost:'127.0.0.1',publicOrigin:origin,sessionSecret:'projection-test-secret-abcdefghijklmnopqrstuvwxyz',databasePath};
  let app=await createRelay(config),host:WebSocket|undefined;
  try{
    const owner=await login(app,'alice'),foreign=await login(app,'bob'),hostToken='host-projection-token-abcdefghijklmnopqrstuvwxyz';
    await app.relayStore.upsertHost({id:'host-one',accountId:owner.user.id,name:'Mac',hostToken});
    const address=(await app.listen({host:'127.0.0.1',port:0})).replace('http','ws');
    host=new WebSocket(`${address}/ws/host`,{headers:{authorization:`Bearer ${hostToken}`,'x-host-id':'host-one'}});await once(host,'open');
    host.on('message',data=>{const request=JSON.parse(data.toString());if(request.method==='list')host!.send(JSON.stringify({type:'result',requestId:request.requestId,result:{host:{id:'host-one',name:'Mac',roots:[project.path]},projects:[project],sessions:[session]}}));});
    const online=(await app.inject({url:'/api/state',headers:{cookie:owner.cookie}})).json();assert.equal(online.projects[0].path,project.path);assert.equal(online.sessions[0].nativeSessionId,session.nativeSessionId);
    // A state event introduces a session even when no later list request occurs.
    host.send(JSON.stringify({type:'event',event:'state',hostId:'host-one',project:{...project,id:'project-two',name:'Second',path:'/Users/private-author/second-project'},session:{...session,id:'session-two',projectId:'project-two',title:'Second session'}}));
    host.send(JSON.stringify({type:'event',event:'state',hostId:'host-one',session:{...session,title:'Updated title',activity:'approval'}}));
    const closed=once(host,'close');host.close();await closed;
    const offline=(await app.inject({url:'/api/state',headers:{cookie:owner.cookie}})).json();assert.equal(offline.hosts[0].online,false);assert.equal(offline.projects.length,2);assert.equal(offline.sessions.length,2);
    assert.equal(offline.projects[0].path,'');const summary=offline.sessions.find((s:any)=>s.id==='session-one');assert.equal(summary.title,'Updated title');assert.equal(summary.activity,'approval');assert.equal(summary.nativeSessionId,null);assert.equal(summary.controller,null);assert.equal(summary.input,undefined);assert.equal(summary.warning,undefined);
    assert.deepEqual((await app.inject({url:'/api/state',headers:{cookie:foreign.cookie}})).json(),{hosts:[],projects:[],sessions:[]});
    await app.close();
    for(const file of readdirSync(dir)){const bytes=readFileSync(join(dir,file));for(const excluded of ['/Users/private-author/',session.nativeSessionId,session.data,session.input,'private hook body','tab-secret'])assert.equal(bytes.includes(Buffer.from(excluded)),false,`Projection must not persist ${excluded}`);}
    app=await createRelay(config);
    const restarted=(await app.inject({url:'/api/state',headers:{cookie:owner.cookie}})).json();assert.equal(restarted.projects.length,2);assert.equal(restarted.sessions.length,2);assert.equal(restarted.projects[0].path,'');assert.equal(restarted.sessions.find((s:any)=>s.id==='session-one').title,'Updated title');
    assert.deepEqual((await app.inject({url:'/api/state',headers:{cookie:foreign.cookie}})).json(),{hosts:[],projects:[],sessions:[]});
    const revoked=await app.inject({method:'POST',url:'/api/hosts/host-one/revoke',headers:{cookie:owner.cookie,origin,'x-csrf-token':owner.csrf}});assert.equal(revoked.statusCode,200);
    assert.deepEqual((await app.inject({url:'/api/state',headers:{cookie:owner.cookie}})).json(),{hosts:[],projects:[],sessions:[]});
    const db=new DatabaseSync(databasePath,{readOnly:true});assert.equal((db.prepare('SELECT count(*) AS n FROM host_projections').get() as any).n,0);db.close();
  }finally{host?.terminate();await app.close();rmSync(dir,{recursive:true,force:true});}
});
