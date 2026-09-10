import {createCipheriv,createDecipheriv,createECDH,createHash,generateKeyPairSync,hkdfSync,sign,type KeyPairKeyObjectResult} from 'node:crypto';
const b64=(value:Uint8Array)=>Buffer.from(value).toString('base64url');
export const testIdentity=()=>generateKeyPairSync('ed25519');
export const identityFingerprint=(identity:KeyPairKeyObjectResult)=>b64(createHash('sha256').update(identity.publicKey.export({format:'der',type:'spki'})).digest());
export function accept(identity:KeyPairKeyObjectResult,hello:any){
  const host=createECDH('prime256v1');host.generateKeys();const hostPublicKey=b64(identity.publicKey.export({format:'der',type:'spki'})),hostEphemeralPublicKey=b64(host.getPublicKey());
  const payload=JSON.stringify(['polyhedron-channel-v1',hello.hostId,hello.channelId,hello.clientPublicKey,hostPublicKey,hostEphemeralPublicKey]);
  const response={v:1,hostId:hello.hostId,channelId:hello.channelId,hostPublicKey,fingerprint:b64(createHash('sha256').update(Buffer.from(hostPublicKey,'base64url')).digest()),hostEphemeralPublicKey,signature:b64(sign(null,Buffer.from(payload),identity.privateKey))};
  const keys=Buffer.from(hkdfSync('sha256',host.computeSecret(Buffer.from(hello.clientPublicKey,'base64url')),Buffer.from(hello.channelId),Buffer.from('polyhedron-channel-v1'),64));let sent=0,received=0;
  const iv=(nonce:number)=>{const value=Buffer.alloc(12);value.writeBigUInt64BE(BigInt(nonce),4);return value},aad=(direction:string)=>Buffer.from(`polyhedron:v1:${hello.channelId}:${direction}`);
  return {hello:response,channel:{open(frame:any){if(frame.nonce!==++received)throw new Error('nonce');const body=Buffer.from(frame.ciphertext,'base64url'),cipher=createDecipheriv('aes-256-gcm',keys.subarray(0,32),iv(frame.nonce));cipher.setAAD(aad('b2h'));cipher.setAuthTag(body.subarray(-16));return JSON.parse(Buffer.concat([cipher.update(body.subarray(0,-16)),cipher.final()]).toString())},seal(value:any){const nonce=++sent,cipher=createCipheriv('aes-256-gcm',keys.subarray(32),iv(nonce));cipher.setAAD(aad('h2b'));const body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]);return {v:1,nonce,ciphertext:b64(body)}}}};
}
