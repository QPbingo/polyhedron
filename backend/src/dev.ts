import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,openSync,closeSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {hostname} from 'node:os';
import {writePrivateJson} from './host/config.js';
const backend=fileURLToPath(new URL('../',import.meta.url)),dir=join(backend,'.data');mkdirSync(dir,{recursive:true,mode:0o700});
const hostPath=join(dir,'host.json'),secretPath=join(dir,'development.json');
if(!existsSync(hostPath))writePrivateJson(hostPath,{hostId:randomUUID(),accountId:'dev-local',hostToken:randomBytes(32).toString('hex'),masterKey:randomBytes(32).toString('base64url'),ipcToken:randomBytes(32).toString('hex'),relayUrl:'ws://127.0.0.1:3001/ws/host',name:hostname(),roots:[resolve(backend,'..')],dataDir:dir});
const host=JSON.parse(readFileSync(hostPath,'utf8'));if(host.accountId!=='dev-local'||!host.hostToken)throw new Error('现有配置不是开发主机；请分别启动正式 host、connector 与 relay');if(!host.masterKey){host.masterKey=randomBytes(32).toString('base64url');host.masterKeyMigration='hostToken-v1';writePrivateJson(hostPath,host)}
if(!existsSync(secretPath))writePrivateJson(secretPath,{relaySessionSecret:randomBytes(32).toString('hex')});
const secret=JSON.parse(readFileSync(secretPath,'utf8'));const env={...process.env,HOST_CONFIG:hostPath};
const pidPath=join(dir,'host.pid');let hostRunning=false;if(existsSync(pidPath)){try{process.kill(Number(readFileSync(pidPath,'utf8')),0);hostRunning=true;}catch{}}
if(!hostRunning){const log=openSync(join(dir,'host-service.log'),'a',0o600);const child=spawn(process.execPath,['--import','tsx','src/host/main.ts'],{cwd:backend,env,detached:true,stdio:['ignore',log,log]});child.unref();closeSync(log);}
const relay=spawn(process.execPath,['--import','tsx','src/relay/main.ts'],{cwd:backend,env:{...env,DEV_AUTH:'1',BIND_HOST:'127.0.0.1',PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN??'http://127.0.0.1:18417',RELAY_SESSION_SECRET:secret.relaySessionSecret,DEV_HOST_CONFIG:hostPath,RELAY_DB_PATH:join(dir,'relay.sqlite')},stdio:'inherit'});
const connector=spawn(process.execPath,['--import','tsx','src/connector/main.ts'],{cwd:backend,env,stdio:'inherit'});
let stopping=false;function stop(){if(stopping)return;stopping=true;relay.kill('SIGTERM');connector.kill('SIGTERM');console.log('中继与连接服务已停止；本地会话主机继续运行。停止主机：npm run host:stop');}
for(const child of [relay,connector])child.on('exit',()=>{if(!stopping)stop();});process.on('SIGINT',stop);process.on('SIGTERM',stop);
console.log('开发后端启动中。请在 frontend/ 运行 npm run dev，然后打开 http://127.0.0.1:18417/');
