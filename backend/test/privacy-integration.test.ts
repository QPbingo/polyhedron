import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createFixture,until} from './fixtures/setup.js';
import {createEncryptedClient} from './fixtures/secure-client.js';
import {Pool} from 'pg';

function rawFiles(path:string){return [path,`${path}-wal`,`${path}-shm`].filter(existsSync).map(file=>readFileSync(file).toString('latin1')).join('\n')}

async function exercise(databaseUrl?:string){
  const nonce=`SENSITIVE_${Date.now()}_${Math.random().toString(16).slice(2)}`,projectName=`${nonce}_PROJECT`,directoryName=`${nonce}_DIRECTORY`,sessionTitle=`${nonce}_SESSION`,prompt=`${nonce}_PROMPT`;
  const f=await createFixture(0,'http://127.0.0.1:15174',databaseUrl),client=await createEncryptedClient(f);const projectPath=join(f.root,directoryName);mkdirSync(projectPath);
  try{
    const project=await client.call('addProject',{name:projectName,path:projectPath});
    const session=await client.call('createSession',{projectId:project.id,title:sessionTitle,agent:'codex'});
    const snapshot=await client.call('attach',{sessionId:session.id,lastAppliedOffset:0});
    const owner=await client.call('claimControl',{sessionId:session.id,runtimeOffset:snapshot.session.runtimeOffset});
    await client.call('resize',{sessionId:session.id,runtimeOffset:owner.runtimeOffset,controlOffset:owner.controlOffset,cols:88,rows:26});
    await client.call('input',{sessionId:session.id,runtimeOffset:owner.runtimeOffset,controlOffset:owner.controlOffset,data:`${prompt}\r`});
    await until(()=>client.events.some(event=>event.kind==='pty_output'&&event.data.includes(`ACK:${prompt}`)));
    const listed=await client.call('list'),history=await client.call('history',{sessionId:session.id,runtimeOffset:owner.runtimeOffset});
    assert.equal(listed.projects.find((item:any)=>item.id===project.id).path,projectPath);assert.equal(listed.sessions.find((item:any)=>item.id===session.id).title,sessionTitle);assert.ok(history.entries.some((entry:any)=>entry.data.includes(`ACK:${prompt}`)));
    const sentinels=[projectName,directoryName,sessionTitle,prompt],routed=client.frames.join('\n'),relayDisk=f.databasePath?rawFiles(f.databasePath):'',hostDisk=rawFiles(join(f.config.dataDir!,'host.sqlite')),logs=f.logs.join('\n');let relayRows='';if(databaseUrl){const pool=new Pool({connectionString:databaseUrl});try{for(const table of ['accounts','browser_sessions','host_bindings','pairings','oidc_flows','audit_events'])relayRows+=(await pool.query(`SELECT COALESCE(string_agg(row_to_json(item)::text,E'\\n'),'') AS body FROM (SELECT * FROM ${table}) item`)).rows[0].body+'\n'}finally{await pool.end()}}
    for(const sentinel of sentinels){assert.doesNotMatch(routed,new RegExp(sentinel));assert.doesNotMatch(relayDisk,new RegExp(sentinel));assert.doesNotMatch(relayRows,new RegExp(sentinel));assert.doesNotMatch(logs,new RegExp(sentinel));assert.doesNotMatch(hostDisk,new RegExp(sentinel))}
  }finally{client.close();await f.close();}
}

test('privacy boundary keeps project, session, prompt and output plaintext off Relay storage, logs and transport',()=>exercise());
test('PostgreSQL-facing rows contain no routed business plaintext',{skip:!process.env.TEST_DATABASE_URL},()=>exercise(process.env.TEST_DATABASE_URL));
