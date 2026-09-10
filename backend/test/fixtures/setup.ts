import {mkdtempSync,mkdirSync,realpathSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {SignJWT} from 'jose';
import {createRelay} from '../../src/relay/app.js';
import {HostManager} from '../../src/host/manager.js';
import {createHostServer} from '../../src/host/server.js';
import {writePrivateJson} from '../../src/host/config.js';
import type {HostConfig} from '../../src/shared/types.js';
export async function until(check:()=>Promise<boolean>|boolean,ms=10000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,40));}}
export async function createFixture(port=0,origin='http://127.0.0.1:15174',databaseUrl?:string){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'poly-e2e-'))),root=join(dir,'projects');mkdirSync(root);mkdirSync(join(root,'workbench'));mkdirSync(join(root,'notes'));
 const secret=randomBytes(32).toString('hex'),config:HostConfig={hostId:randomUUID(),accountId:'dev-local',hostToken:randomBytes(32).toString('hex'),masterKey:randomBytes(32).toString('base64url'),ipcToken:randomBytes(32).toString('hex'),relayUrl:'',name:'Integration Mac',roots:[root],dataDir:join(dir,'data')};
 const databasePath=databaseUrl?undefined:join(dir,'relay.sqlite'),options={devAuth:true,bindHost:'127.0.0.1',publicOrigin:origin,sessionSecret:secret,...(databaseUrl?{databaseUrl}:{databasePath})};
 let relay=await createRelay(options);await relay.relayStore.upsertAccount({id:'dev-local',name:'本地用户',issuer:'development',subject:'本地用户'});await relay.relayStore.upsertHost({id:config.hostId,accountId:config.accountId,name:config.name,hostToken:config.hostToken});await relay.listen({port,host:'127.0.0.1'});const address=relay.server.address() as any;const actualPort=address.port;config.relayUrl=`ws://127.0.0.1:${actualPort}/ws/host`;
 const manager=new HostManager(config,{detect:async()=>[{id:'codex',name:'Codex · PTY test fixture',available:true,version:'fixture',path:process.execPath}],launch:async()=>({file:process.execPath,args:[fileURLToPath(new URL('./terminal.cjs',import.meta.url))],env:{}})});
 const local=await createHostServer(config,manager);await local.app.listen({path:join(config.dataDir!,'host.sock')});chmodSync(join(config.dataDir!,'host.sock'),0o600);
 const configPath=join(config.dataDir!,'host.json');writePrivateJson(configPath,config);
 const logs:string[]=[];function connect():ChildProcess{const child=spawn(process.execPath,['--import','tsx','src/connector/main.ts'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),env:{...process.env,HOST_CONFIG:configPath},stdio:['ignore','pipe','pipe']});child.stdout?.on('data',chunk=>logs.push(String(chunk)));child.stderr?.on('data',chunk=>logs.push(String(chunk)));return child;}
 let connector=connect();
 async function direct(method:string,params:Record<string,unknown>={}){const clientId=randomUUID(),body={operationId:randomUUID(),...params};const grant=await new SignJWT({hostId:config.hostId,clientId,scope:'host',method,sessionId:body.sessionId}).setSubject(config.accountId).setProtectedHeader({alg:'HS256'}).setExpirationTime('30s').sign(new TextEncoder().encode(config.hostToken));return manager.rpc({type:'rpc',requestId:randomUUID(),clientId,channelId:clientId,grant,method,params:body});}
 const project=await direct('addProject',{name:'workbench',path:join(root,'workbench')});const session=await direct('createSession',{projectId:project.id,title:'真实 PTY 联调',agent:'codex'});
 async function waitOnline(){await until(async()=>{const res=await relay.inject({method:'POST',url:'/auth/dev',headers:{origin},payload:{}});const cookie=res.cookies[0];const state=await relay.inject({url:'/api/state',cookies:{[cookie.name]:cookie.value}});return state.json().hosts[0]?.online===true;});}
 await waitOnline();
 return {config,project,session,root,dir,databasePath,databaseUrl,logs,origin,port:actualPort,get relay(){return relay;},manager,direct,
  async restartConnector(){connector.kill('SIGTERM');await new Promise<void>(r=>connector.once('exit',()=>r()));connector=connect();await waitOnline();},
  async restartRelay(){await relay.close();relay=await createRelay(options);await relay.listen({port:actualPort,host:'127.0.0.1'});await waitOnline();},
  async close(){connector.kill('SIGTERM');await relay.close();await local.app.close();rmSync(dir,{recursive:true,force:true});}
 };
}
