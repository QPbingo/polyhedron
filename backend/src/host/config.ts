import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {readHostToken} from '../adapters/keychain.js';
import type {HostConfig} from '../shared/types.js';
export function configPath(){const i=process.argv.indexOf('--config');return resolve(i>=0?process.argv[i+1]:process.env.HOST_CONFIG??'.data/host.json');}
export async function loadConfig(path=configPath()):Promise<HostConfig>{
 const value=JSON.parse(readFileSync(path,'utf8'));
 if(value.hostTokenKeychain)value.hostToken=await readHostToken(value.hostTokenKeychain.service,value.hostTokenKeychain.account);
 for(const key of ['hostId','accountId','hostToken','ipcToken','relayUrl','name'])if(typeof value[key]!=='string'||!value[key])throw new Error('主机配置缺少 '+key);
 if(!Array.isArray(value.roots)||!value.roots.length||value.roots.some((x:unknown)=>typeof x!=='string'))throw new Error('请先配置本地授权项目根目录');
 if(value.hostToken.length<32||value.ipcToken.length<32)throw new Error('主机凭据长度不足，请重新绑定');
 const relay=new URL(value.relayUrl);if(relay.protocol!=='wss:'&&!(relay.protocol==='ws:'&&['localhost','127.0.0.1','[::1]'].includes(relay.hostname)))throw new Error('远程中继必须使用 WSS');
 value.dataDir=resolve(value.dataDir??dirname(path));return value;
}
export function writePrivateJson(path:string,value:unknown){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});chmodSync(path,0o600);}
