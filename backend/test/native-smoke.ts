// Opt-in native CLI startup only: no prompt, trust approval or model request is sent.
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import {HostManager} from '../src/host/manager.js';
import {createHostServer} from '../src/host/server.js';
import type {HostConfig} from '../src/shared/types.js';
const dir=realpathSync(mkdtempSync(join(tmpdir(),'poly-native-smoke-'))),root=join(dir,'project');mkdirSync(root);
const config:HostConfig={hostId:randomUUID(),accountId:'smoke',hostToken:randomBytes(32).toString('hex'),ipcToken:randomBytes(32).toString('hex'),relayUrl:'ws://127.0.0.1:3001/ws/host',name:'Native smoke',roots:[root],dataDir:join(dir,'data')};
const manager=new HostManager(config),local=await createHostServer(config,manager);await local.app.listen({path:join(config.dataDir!,'host.sock')});
const clientId=randomUUID();async function call(method:string,params:any={}){const grant=await new SignJWT({hostId:config.hostId,clientId,scope:'host',method,sessionId:params.sessionId,runtimeEpoch:params.runtimeEpoch}).setSubject(config.accountId).setProtectedHeader({alg:'HS256'}).setExpirationTime('30s').sign(new TextEncoder().encode(config.hostToken));return manager.rpc({type:'rpc',requestId:randomUUID(),clientId,grant,method,params});}
const reports:any[]=[];
try{
 const p=await call('addProject',{name:'Native startup smoke',path:root});
 for(const agent of ['codex','claude']){
  const s=await call('createSession',{projectId:p.id,title:agent+' startup only',agent});await call('attach',{sessionId:s.id});
  await new Promise(r=>setTimeout(r,6000));const snap=await call('attach',{sessionId:s.id});
  reports.push({agent,processState:snap.session.processState,parsedOutputSeq:snap.seq,screenBytes:Buffer.byteLength(snap.data),nativeIdCaptured:!!snap.session.nativeSessionId,activity:snap.session.activity,containsTrustPrompt:/trust|信任|Trust/.test(snap.data),containsConfigurationError:/error (?:loading|parsing)|unknown field|invalid config|unexpected argument/i.test(snap.data)});
  if(snap.session.processState==='running'){const owner=await call('claimControl',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch});await call('terminate',{sessionId:s.id,runtimeEpoch:s.runtimeEpoch,controlEpoch:owner.controlEpoch,confirm:true});await new Promise(r=>setTimeout(r,1800));}
 }
 console.log(JSON.stringify(reports,null,2));if(reports.some(r=>r.screenBytes===0||r.containsConfigurationError))process.exitCode=1;
}finally{await local.app.close();rmSync(dir,{recursive:true,force:true});}
