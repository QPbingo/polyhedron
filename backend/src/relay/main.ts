import {readFileSync} from 'node:fs';
import {createRelay,isLoopback} from './app.js';

const devAuth=process.env.DEV_AUTH==='1';
const bindHost=process.env.BIND_HOST??process.env.HOST??'127.0.0.1';
const app=await createRelay({
  devAuth,bindHost,publicOrigin:process.env.PUBLIC_ORIGIN,
  sessionSecret:process.env.RELAY_SESSION_SECRET,
  databasePath:process.env.RELAY_DB_PATH??'.data/relay.sqlite',databaseUrl:process.env.DATABASE_URL,
  oidc:process.env.OIDC_ISSUER&&process.env.OIDC_CLIENT_ID?{issuer:process.env.OIDC_ISSUER,clientId:process.env.OIDC_CLIENT_ID,clientSecret:process.env.OIDC_CLIENT_SECRET}:undefined,
});
if(process.env.DEV_HOST_CONFIG){
  if(!devAuth||!isLoopback(bindHost))throw new Error('DEV_HOST_CONFIG is only allowed in explicit loopback development mode');
  const host=JSON.parse(readFileSync(process.env.DEV_HOST_CONFIG,'utf8'));
  if(host.accountId!=='dev-local'||typeof host.hostId!=='string'||typeof host.hostToken!=='string'||host.hostToken.length<32)throw new Error('Invalid development host configuration');
  await app.relayStore.upsertAccount({id:'dev-local',name:'本地用户',issuer:'development',subject:'本地用户'});
  await app.relayStore.upsertHost({id:host.hostId,accountId:host.accountId,name:host.name??'本机 Mac',hostToken:host.hostToken});
}
await app.listen({port:Number(process.env.PORT??3001),host:bindHost});
console.log(`Relay listening on ${bindHost}:${process.env.PORT??3001} (${devAuth?'explicit local development':'OIDC'})`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0))});
