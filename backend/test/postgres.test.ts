import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRelay} from '../src/relay/app.js';
test('PostgreSQL relay persists browser ownership and atomically issues one paired host',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const origin='http://127.0.0.1:15174';const app=await createRelay({devAuth:true,bindHost:'127.0.0.1',publicOrigin:origin,sessionSecret:'postgres-test-secret-with-at-least-32-characters',databaseUrl:process.env.TEST_DATABASE_URL});
 try{
  const login=await app.inject({method:'POST',url:'/auth/dev',headers:{origin},payload:{name:'postgres-'+randomUUID()}});assert.equal(login.statusCode,200);const auth=login.json(),cookie=login.cookies[0];const headers={origin,cookie:cookie.name+'='+cookie.value,'x-csrf-token':auth.csrfToken};
  const pairing=await app.inject({method:'POST',url:'/api/pairings/start',payload:{name:'PostgreSQL test host'}});const p=pairing.json();
  const approval=await app.inject({method:'POST',url:'/api/pairings/approve',headers,payload:{code:p.code}});assert.equal(approval.statusCode,200);
  const attempts=await Promise.all([0,1].map(()=>app.inject({method:'POST',url:'/api/pairings/poll',payload:{pairingId:p.pairingId,pollToken:p.pollToken}})));
  assert.equal(attempts.filter(r=>r.statusCode===200&&r.json().hostToken).length,1);const issued=attempts.find(r=>r.statusCode===200&&r.json().hostToken)!.json();assert.equal(issued.accountId,auth.user.id);
  const hosts=await app.inject({url:'/api/hosts',headers});assert.ok(hosts.json().hosts.some((h:any)=>h.id===issued.hostId));
  const state=await app.inject({url:'/api/state',headers});assert.equal(state.json().hosts.find((h:any)=>h.id===issued.hostId).online,false);
  const logout=await app.inject({method:'POST',url:'/auth/logout',headers,payload:{}});assert.equal(logout.statusCode,200);assert.equal((await app.inject({url:'/api/hosts',headers})).statusCode,401);
 }finally{await app.close();}
});
