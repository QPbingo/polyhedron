import {openSync,writeFileSync,readFileSync,unlinkSync,existsSync,mkdirSync,closeSync,statSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {loadConfig} from './config.js';
import {listenHost} from './server.js';
const config=await loadConfig();mkdirSync(config.dataDir!,{recursive:true,mode:0o700});
const startupLock=join(config.dataDir!,'host-startup.lock');
try{mkdirSync(startupLock,{mode:0o700});}catch{throw new Error('主机正在启动，或启动锁未清理；请检查 host.pid 对应进程后再清理 host-startup.lock');}
let startupLocked=true;const unlock=()=>{if(startupLocked){rmdirSync(startupLock);startupLocked=false;}};
const pidPath=join(config.dataDir!,'host.pid');
try {
// Take the process lock before opening SQLite or marking interrupted records.
if(existsSync(pidPath)){
 const pid=Number(readFileSync(pidPath,'utf8'));if((!Number.isSafeInteger(pid)||pid<2)&&Date.now()-statSync(pidPath).mtimeMs<30000)throw new Error('另一主机服务正在启动');let active=false;
 if(Number.isSafeInteger(pid)&&pid>1){try{process.kill(pid,0);active=true;}catch(error:any){if(error.code==='EPERM')active=true;}}
 if(active)throw new Error('主机执行服务已经运行');unlinkSync(pidPath);
}
const fd=openSync(pidPath,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);
const socketPath=join(config.dataDir!,'host.sock');if(existsSync(socketPath))unlinkSync(socketPath);
try{
 const {app}=await listenHost(config);unlock();console.log('本地会话执行服务已就绪');
 let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();try{unlinkSync(pidPath);}catch{}process.exit(0);};process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
}catch(error){try{unlinkSync(pidPath);}catch{}throw error;}

} finally { unlock(); }
