import {openSync,writeFileSync,readFileSync,unlinkSync,existsSync,mkdirSync,closeSync,statSync,fsyncSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {completeMasterKeyMigration,configDataDir,configPath,loadConfig} from './config.js';
import {listenHost} from './server.js';

const path=configPath(),dataDir=configDataDir(path);mkdirSync(dataDir,{recursive:true,mode:0o700});const pidPath=join(dataDir,'host.pid');
function syncDirectory(){const fd=openSync(dataDir,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
async function acquirePid(){for(let attempt=0;attempt<100;attempt++)try{const fd=openSync(pidPath,'wx',0o600);try{writeFileSync(fd,String(process.pid));fsyncSync(fd)}finally{closeSync(fd)}syncDirectory();return}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;let before,after,text='';try{before=lstatSync(pidPath);text=readFileSync(pidPath,'utf8');after=lstatSync(pidPath)}catch{continue}if(before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)continue;const pid=Number(text);let active=false;if(Number.isSafeInteger(pid)&&pid>1)try{process.kill(pid,0);active=true}catch(failure:any){if(failure.code==='EPERM')active=true}if(active)throw new Error('主机执行服务已经运行');if((!Number.isSafeInteger(pid)||pid<2)&&Date.now()-after.mtimeMs<1000){await new Promise(resolve=>setTimeout(resolve,25));continue}try{const current=lstatSync(pidPath);if(current.ino===after.ino&&current.mtimeMs===after.mtimeMs){unlinkSync(pidPath);syncDirectory()}}catch{} }throw new Error('无法安全获取主机进程锁，请检查 host.pid')}
function releasePid(){try{if(readFileSync(pidPath,'utf8')===String(process.pid)){unlinkSync(pidPath);syncDirectory()}}catch{}}

await acquirePid();let ready=false;
try{
 const config=await loadConfig(path),socketPath=join(config.dataDir!,'host.sock');if(existsSync(socketPath))unlinkSync(socketPath);
 const {app}=await listenHost(config);completeMasterKeyMigration(path);ready=true;console.log('本地会话执行服务已就绪');let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();releasePid();process.exit(0)};process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}catch(error){if(!ready)releasePid();throw error}
