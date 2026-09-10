import {readFileSync,mkdirSync,chmodSync,openSync,writeSync,fsyncSync,closeSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {resolve,dirname,join,basename} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {JOURNAL_FAILED,JOURNAL_HEALTHY,readHostToken,storeHostToken} from '../adapters/keychain.js';
import type {HostConfig} from '../shared/types.js';

export interface ConnectorConfig {hostId:string;accountId:string;hostToken:string;ipcToken:string;relayUrl:string;dataDir:string}
export interface AtomicWriteOptions {beforeRename?:()=>void;afterRename?:()=>void}
interface ConfigDependencies {readSecret?:(service:string,account:string)=>Promise<string>;storeSecret?:(service:string,account:string,value:string)=>Promise<void>;randomSecret?:()=>string;platform?:string;writeOptions?:AtomicWriteOptions}
const configLocks=new Map<string,Promise<void>>();

export function configPath(){const i=process.argv.indexOf('--config');return resolve(i>=0?process.argv[i+1]:process.env.HOST_CONFIG??'.data/host.json')}
function rawConfig(path:string){return JSON.parse(readFileSync(path,'utf8')) as any}
export function configDataDir(path=configPath()){const value=rawConfig(path);return resolve(value.dataDir??dirname(path))}
function validateRelay(value:any){const relay=new URL(value.relayUrl);if(relay.protocol!=='wss:'&&!(relay.protocol==='ws:'&&['localhost','127.0.0.1','[::1]'].includes(relay.hostname)))throw new Error('远程中继必须使用 WSS')}
function validateConnector(value:any){for(const key of ['hostId','accountId','hostToken','ipcToken','relayUrl'])if(typeof value[key]!=='string'||!value[key])throw new Error('主机配置缺少 '+key);if(value.hostToken.length<32||value.ipcToken.length<32)throw new Error('主机凭据长度不足，请重新绑定');validateRelay(value)}
async function serialized<T>(path:string,work:()=>Promise<T>):Promise<T>{const previous=configLocks.get(path)??Promise.resolve();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),tail=previous.then(()=>gate);configLocks.set(path,tail);await previous;try{return await work()}finally{release();if(configLocks.get(path)===tail)configLocks.delete(path)}}

export async function loadConnectorConfig(path=configPath(),deps:ConfigDependencies={}):Promise<ConnectorConfig>{const value=rawConfig(path),read=deps.readSecret??readHostToken;value.dataDir=resolve(value.dataDir??dirname(path));if(value.hostTokenKeychain)value.hostToken=await read(value.hostTokenKeychain.service,value.hostTokenKeychain.account);validateConnector(value);return {hostId:value.hostId,accountId:value.accountId,hostToken:value.hostToken,ipcToken:value.ipcToken,relayUrl:value.relayUrl,dataDir:value.dataDir}}

export async function loadConfig(path=configPath(),deps:ConfigDependencies={}):Promise<HostConfig>{return serialized(path,async()=>{
 const value=rawConfig(path),read=deps.readSecret??readHostToken,store=deps.storeSecret??storeHostToken,random=deps.randomSecret??(()=>randomBytes(32).toString('base64url')),platform=deps.platform??process.platform;value.dataDir=resolve(value.dataDir??dirname(path));
 if(value.hostTokenKeychain)value.hostToken=await read(value.hostTokenKeychain.service,value.hostTokenKeychain.account);
 if(value.masterKeyKeychain)value.masterKey=await read(value.masterKeyKeychain.service,value.masterKeyKeychain.account);
 if(!value.masterKey){if(value.hostTokenKeychain&&platform==='darwin'){const service='com.polyhedron.master',account=value.hostId;try{value.masterKey=await read(service,account)}catch{const candidate=random();await store(service,account,candidate);value.masterKey=await read(service,account)}value.masterKeyKeychain={service,account}}else if(value.hostToken)value.masterKey=random();else throw new Error('主机配置缺少独立本地主密钥');value.masterKeyMigration='hostToken-v1';const persisted={...value};if(persisted.hostTokenKeychain)delete persisted.hostToken;if(persisted.masterKeyKeychain)delete persisted.masterKey;writePrivateJson(path,persisted,deps.writeOptions)}
 if(value.masterKeyKeychain&&platform==='darwin'){if(!value.healthLatchKeychain){const service='com.polyhedron.health',account=value.hostId;try{const existing=await read(service,account);if(existing!==JOURNAL_HEALTHY&&existing!==JOURNAL_FAILED)throw new Error('invalid')}catch{await store(service,account,JOURNAL_HEALTHY)}value.healthLatchKeychain={service,account};const persisted={...value};delete persisted.hostToken;delete persisted.masterKey;delete persisted.legacyMasterKey;delete persisted.journalFailureLatched;writePrivateJson(path,persisted,deps.writeOptions)}const health=await read(value.healthLatchKeychain.service,value.healthLatchKeychain.account);if(health!==JOURNAL_HEALTHY&&health!==JOURNAL_FAILED)throw new Error('主机 Keychain journal 健康锁无效');value.journalFailureLatched=health===JOURNAL_FAILED}
 if(value.masterKeyMigration==='hostToken-v1')value.legacyMasterKey=value.hostToken;
 validateConnector(value);if(typeof value.name!=='string'||!value.name)throw new Error('主机配置缺少 name');if(!Array.isArray(value.roots)||!value.roots.length||value.roots.some((x:unknown)=>typeof x!=='string'))throw new Error('请先配置本地授权项目根目录');if(value.masterKey.length<32)throw new Error('主机凭据长度不足，请重新绑定');return value;
})}

export function completeMasterKeyMigration(path=configPath(),options?:AtomicWriteOptions){const value=rawConfig(path);if(!value.masterKeyMigration)return;delete value.masterKeyMigration;writePrivateJson(path,value,options)}
export function writePrivateJson(path:string,value:unknown,options:AtomicWriteOptions={}){const directory=dirname(path),body=Buffer.from(JSON.stringify(value,null,2)+'\n'),temporary=join(directory,`.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);mkdirSync(directory,{recursive:true,mode:0o700});let mode=0o600;try{const current=statSync(path).mode&0o777;if((current&0o077)===0)mode=current}catch{}let fd:number|undefined;try{fd=openSync(temporary,'wx',mode);let offset=0;while(offset<body.length)offset+=writeSync(fd,body,offset,body.length-offset,offset);fsyncSync(fd);closeSync(fd);fd=undefined;chmodSync(temporary,mode);options.beforeRename?.();renameSync(temporary,path);options.afterRename?.();const parent=openSync(directory,'r');try{fsyncSync(parent)}finally{closeSync(parent)}}catch(error){if(fd!==undefined)try{closeSync(fd)}catch{}try{unlinkSync(temporary)}catch{}throw error}}
