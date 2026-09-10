import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes,timingSafeEqual} from 'node:crypto';

function stable(value:unknown):string{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  const source=value as Record<string,unknown>;
  return `{${Object.keys(source).sort().map(key=>`${JSON.stringify(key)}:${stable(source[key])}`).join(',')}}`;
}

type Envelope={v:1;iv:string;tag:string;data:string};

export class LocalCipher{
  private readonly wrappingKey:Buffer;
  readonly domainKey:Buffer;
  constructor(secret:string,hostId:string){
    if(secret.length<16)throw new Error('Host encryption secret is too short');
    this.wrappingKey=Buffer.from(hkdfSync('sha256',Buffer.from(secret),Buffer.from(hostId),Buffer.from('polyhedron-host-wrapping-v1'),32));
    this.domainKey=Buffer.from(hkdfSync('sha256',this.wrappingKey,Buffer.from(hostId),Buffer.from('polyhedron-host-domain-v1'),32));
  }
  randomKey(){return randomBytes(32)}
  digest(value:string|Buffer){return createHash('sha256').update(value).digest('hex')}
  eventHash(key:Buffer,value:string){return createHmac('sha256',key).update(value).digest('hex')}
  equal(left:string,right:string){const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b)}
  sealJson(value:unknown,key=this.domainKey,aad='domain'){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));
    const data=Buffer.concat([cipher.update(stable(value),'utf8'),cipher.final()]);
    const envelope:Envelope={v:1,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')};
    return `enc:v1:${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;
  }
  openJson<T>(encoded:string,key=this.domainKey,aad='domain'):T{
    if(!encoded.startsWith('enc:v1:'))throw new Error('Encrypted value has an unsupported format');
    const envelope=JSON.parse(Buffer.from(encoded.slice(7),'base64url').toString('utf8')) as Envelope;
    if(envelope.v!==1)throw new Error('Encrypted value has an unsupported version');
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64url'));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(Buffer.from(envelope.tag,'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data,'base64url')),decipher.final()]).toString('utf8')) as T;
  }
  wrapKey(key:Buffer,streamId:string){return this.sealJson({key:key.toString('base64url')},this.wrappingKey,`stream-key:${streamId}`)}
  unwrapKey(value:string,streamId:string){const decoded=this.openJson<{key:string}>(value,this.wrappingKey,`stream-key:${streamId}`);const key=Buffer.from(decoded.key,'base64url');if(key.length!==32)throw new Error('Invalid wrapped stream key');return key}
}

export const stableJson=stable;
