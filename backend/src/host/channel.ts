import {createCipheriv,createDecipheriv,createECDH,createHash,createPrivateKey,createPublicKey,generateKeyPairSync,hkdfSync,sign} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {LocalCipher} from './crypto.js';
import {writePrivateJson,type AtomicWriteOptions} from './config.js';

export interface ChannelHello{v:1;hostId:string;channelId:string;clientPublicKey:string}
export interface HostChannelHello{v:1;hostId:string;channelId:string;hostPublicKey:string;fingerprint:string;hostEphemeralPublicKey:string;signature:string}
export interface SealedFrame{v:1;nonce:number;ciphertext:string}

const b64=(value:Uint8Array)=>Buffer.from(value).toString('base64url');
const validId=(value:string)=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,200}$/.test(value);

export function channelTranscript(input:{hostId:string;channelId:string;clientPublicKey:string;hostPublicKey:string;hostEphemeralPublicKey:string}){
  return JSON.stringify(['polyhedron-channel-v1',input.hostId,input.channelId,input.clientPublicKey,input.hostPublicKey,input.hostEphemeralPublicKey]);
}

export class HostIdentity{
  private constructor(readonly hostId:string,private privateDer:Buffer,readonly publicKey:string,readonly fingerprint:string){}
  static loadOrCreate(input:{dataDir:string;hostId:string;secret:string;legacySecret?:string;writeOptions?:AtomicWriteOptions}){
    const path=join(input.dataDir,'host-identity.json'),cipher=new LocalCipher(input.secret,input.hostId);let privateDer:Buffer,publicDer:Buffer;
    if(existsSync(path)){
      const stored=JSON.parse(readFileSync(path,'utf8'));
      if(stored.v!==1||typeof stored.privateKeyCipher!=='string'||typeof stored.publicKey!=='string')throw new Error('Host identity file is invalid');
      let encoded:string;try{encoded=cipher.openJson<string>(stored.privateKeyCipher,cipher.domainKey,`host-identity:${input.hostId}`)}catch(error){if(!input.legacySecret)throw error;const legacy=new LocalCipher(input.legacySecret,input.hostId);encoded=legacy.openJson<string>(stored.privateKeyCipher,legacy.domainKey,`host-identity:${input.hostId}`);const migrated={...stored,privateKeyCipher:cipher.sealJson(encoded,cipher.domainKey,`host-identity:${input.hostId}`)};writePrivateJson(path,migrated,input.writeOptions)}privateDer=Buffer.from(encoded,'base64url');publicDer=Buffer.from(stored.publicKey,'base64url');
      const derived=createPublicKey(createPrivateKey({key:privateDer,format:'der',type:'pkcs8'})).export({format:'der',type:'spki'}) as Buffer;if(!derived.equals(publicDer))throw new Error('Host identity key pair does not match');
    }else{
      const pair=generateKeyPairSync('ed25519');privateDer=pair.privateKey.export({format:'der',type:'pkcs8'}) as Buffer;publicDer=pair.publicKey.export({format:'der',type:'spki'}) as Buffer;
      const stored={v:1,publicKey:b64(publicDer),privateKeyCipher:cipher.sealJson(b64(privateDer),cipher.domainKey,`host-identity:${input.hostId}`)};writePrivateJson(path,stored,input.writeOptions);
    }
    return new HostIdentity(input.hostId,privateDer,b64(publicDer),b64(createHash('sha256').update(publicDer).digest()));
  }
  signature(transcript:string){return b64(sign(null,Buffer.from(transcript),createPrivateKey({key:this.privateDer,format:'der',type:'pkcs8'})))}
}

export class HostChannel{
  private sendNonce=0;private receiveNonce=0;
  private constructor(readonly channelId:string,private sendKey:Buffer,private receiveKey:Buffer,private role:'host'|'browser'='host'){}
  static accept(identity:HostIdentity,hello:ChannelHello){
    if(hello.v!==1||hello.hostId!==identity.hostId||!validId(hello.channelId))throw new Error('Invalid channel hello');
    const clientPublicKey=Buffer.from(hello.clientPublicKey,'base64url');if(clientPublicKey.length!==65)throw new Error('Invalid client ephemeral key');
    const ephemeral=createECDH('prime256v1');ephemeral.generateKeys();let shared:Buffer;try{shared=ephemeral.computeSecret(clientPublicKey)}catch{throw new Error('Invalid client ephemeral key')}
    const keys=Buffer.from(hkdfSync('sha256',shared,Buffer.from(hello.channelId),Buffer.from('polyhedron-channel-v1'),64)),hostEphemeralPublicKey=b64(ephemeral.getPublicKey());
    const unsigned={hostId:identity.hostId,channelId:hello.channelId,clientPublicKey:hello.clientPublicKey,hostPublicKey:identity.publicKey,hostEphemeralPublicKey};
    const response:HostChannelHello={v:1,hostId:identity.hostId,channelId:hello.channelId,hostPublicKey:identity.publicKey,fingerprint:identity.fingerprint,hostEphemeralPublicKey,signature:identity.signature(channelTranscript(unsigned))};
    return {hello:response,channel:new HostChannel(hello.channelId,keys.subarray(32,64),keys.subarray(0,32))};
  }
  static forTest(channelId:string,sendKey:Uint8Array,receiveKey:Uint8Array){return new HostChannel(channelId,Buffer.from(sendKey),Buffer.from(receiveKey),'browser')}
  private iv(nonce:number){if(!Number.isSafeInteger(nonce)||nonce<1)throw new Error('Invalid channel nonce');const iv=Buffer.alloc(12);iv.writeBigUInt64BE(BigInt(nonce),4);return iv}
  private aad(direction:'b2h'|'h2b'){return Buffer.from(`polyhedron:v1:${this.channelId}:${direction}`)}
  seal(value:unknown):SealedFrame{
    const nonce=++this.sendNonce,cipher=createCipheriv('aes-256-gcm',this.sendKey,this.iv(nonce));cipher.setAAD(this.aad(this.role==='host'?'h2b':'b2h'));const body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]);return {v:1,nonce,ciphertext:b64(body)};
  }
  open(frame:SealedFrame):any{
    if(frame?.v!==1||frame.nonce!==this.receiveNonce+1||typeof frame.ciphertext!=='string')throw new Error('Channel nonce gap or replay');
    const body=Buffer.from(frame.ciphertext,'base64url');if(body.length<17)throw new Error('Channel authentication failed');
    try{const decipher=createDecipheriv('aes-256-gcm',this.receiveKey,this.iv(frame.nonce));decipher.setAAD(this.aad(this.role==='host'?'b2h':'h2b'));decipher.setAuthTag(body.subarray(-16));const value=JSON.parse(Buffer.concat([decipher.update(body.subarray(0,-16)),decipher.final()]).toString('utf8'));this.receiveNonce=frame.nonce;return value}catch{throw new Error('Channel authentication or decryption failed')}
  }
}
