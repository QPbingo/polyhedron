import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {realpathSync,statSync,existsSync} from 'node:fs';
import {hostname} from 'node:os';
import {randomBytes} from 'node:crypto';
import {storeHostToken} from '../adapters/keychain.js';
import {writePrivateJson} from '../host/config.js';
const {values}=parseArgs({options:{relay:{type:'string'},root:{type:'string',multiple:true},name:{type:'string'},config:{type:'string'},'dev-file-credentials':{type:'boolean'}}});
if(!values.relay||!values.root?.length)throw new Error('用法：npm run pair -- --relay https://your-relay --root /absolute/authorized/project-root [--name Mac]');
const url=new URL(values.relay);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('远程绑定必须使用 HTTPS');
if(values['dev-file-credentials']&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('文件凭据仅适用于本机开发');
const roots=values.root.map(p=>{const path=realpathSync(resolve(p));if(!statSync(path).isDirectory())throw new Error('授权根目录必须是现有文件夹');return path;});
const path=resolve(values.config??'.data/host.json');if(existsSync(path))throw new Error('主机配置已存在，请使用新配置路径或先解绑旧主机');
async function post(endpoint:string,body:any){const response=await fetch(new URL(endpoint,url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data:any=await response.json();if(!response.ok)throw new Error(data.error?.message??'绑定请求失败');return data;}
const pending=await post('/api/pairings/start',{name:values.name??hostname()});console.log('打开 '+new URL('/',url)+' 并登录，在设置中输入绑定码：'+pending.code);
let done=false;
while(Date.now()<(typeof pending.expiresAt==='number'?pending.expiresAt:Date.parse(pending.expiresAt))){
 await new Promise(r=>setTimeout(r,2000));const result=await post('/api/pairings/poll',{pairingId:pending.pairingId,pollToken:pending.pollToken});if(result.status!=='approved')continue;
 const config:any={hostId:result.hostId,accountId:result.accountId,ipcToken:randomBytes(32).toString('hex'),name:values.name??hostname(),roots,relayUrl:new URL('/ws/host',url).toString().replace(/^http/,'ws')};
 if(process.platform==='darwin'&&!values['dev-file-credentials']){const service='com.polyhedron.host',account=result.hostId;await storeHostToken(service,account,result.hostToken);config.hostTokenKeychain={service,account};}else if(values['dev-file-credentials'])config.hostToken=result.hostToken;else throw new Error('正式执行端需要 macOS Keychain');
 writePrivateJson(path,config);console.log('绑定完成，配置已保存。可启动 host 和 connector。');done=true;break;
}
if(!done)throw new Error('绑定码已过期，请重新发起绑定');
