import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const config=resolve(process.env.HOST_CONFIG??'.data/host.json'),path=dirname(config)+'/host.pid';
if(!process.argv.includes('--confirm')){console.error('此操作会中断本地主机持有的真实 Agent 进程。确认后运行 npm run host:stop -- --confirm');process.exit(1);}
if(!existsSync(path)){console.log('主机未运行');process.exit(0);}
const pid=Number(readFileSync(path,'utf8'));if(!Number.isSafeInteger(pid)||pid<2)throw Error('主机 PID 文件无效');
try{process.kill(pid,'SIGTERM');console.log('已请求本地会话主机停止');}catch(error){if(error.code==='ESRCH')console.log('主机进程已退出');else throw error;}
