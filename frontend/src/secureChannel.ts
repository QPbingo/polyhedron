export interface ChannelHello{v:1;hostId:string;channelId:string;clientPublicKey:string}
export interface HostChannelHello{v:1;hostId:string;channelId:string;hostPublicKey:string;fingerprint:string;hostEphemeralPublicKey:string;signature:string}
export interface SealedFrame{v:1;nonce:number;ciphertext:string}
export interface FingerprintStore{get(hostId:string):string|null;set(hostId:string,value:string):void}

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const b64=(value:Uint8Array)=>{let binary='';for(let i=0;i<value.length;i+=0x8000)binary+=String.fromCharCode(...value.subarray(i,i+0x8000));return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')};
const unb64=(value:string)=>{const padded=value.replaceAll('-','+').replaceAll('_','/')+'==='.slice((value.length+3)%4);const binary=atob(padded),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes};
const transcript=(input:{hostId:string;channelId:string;clientPublicKey:string;hostPublicKey:string;hostEphemeralPublicKey:string})=>JSON.stringify(['polyhedron-channel-v1',input.hostId,input.channelId,input.clientPublicKey,input.hostPublicKey,input.hostEphemeralPublicKey]);
const iv=(nonce:number)=>{if(!Number.isSafeInteger(nonce)||nonce<1)throw new Error('Invalid channel nonce');const bytes=new Uint8Array(12);new DataView(bytes.buffer).setBigUint64(4,BigInt(nonce));return bytes};
const localPins=():FingerprintStore=>({get:hostId=>localStorage.getItem(`polyhedron.host-fingerprint.${hostId}`),set:(hostId,value)=>localStorage.setItem(`polyhedron.host-fingerprint.${hostId}`,value)});

export class ChannelError extends Error{readonly code:string;readonly fingerprint?:string;constructor(code:string,message:string,fingerprint?:string){super(message);this.code=code;this.fingerprint=fingerprint}}

export class SecureChannel{
  readonly hello:ChannelHello;readonly hostId:string;readonly channelId:string;private keyPair:CryptoKeyPair;private pins:FingerprintStore;private sendKey?:CryptoKey;private receiveKey?:CryptoKey;private sendNonce=0;private receiveNonce=0;private sendChain:Promise<void>=Promise.resolve();
  private constructor(hostId:string,channelId:string,keyPair:CryptoKeyPair,pins:FingerprintStore,clientPublicKey:string){this.hostId=hostId;this.channelId=channelId;this.keyPair=keyPair;this.pins=pins;this.hello={v:1,hostId,channelId,clientPublicKey}}
  static async begin(hostId:string,channelId=crypto.randomUUID(),pins:FingerprintStore=localPins()){
    if(!hostId||!channelId)throw new ChannelError('INVALID_CHANNEL','通道标识无效');const keyPair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']) as CryptoKeyPair;const publicKey=new Uint8Array(await crypto.subtle.exportKey('raw',keyPair.publicKey));return new SecureChannel(hostId,channelId,keyPair,pins,b64(publicKey));
  }
  async complete(hello:HostChannelHello){
    if(hello?.v!==1||hello.hostId!==this.hostId||hello.channelId!==this.channelId)throw new ChannelError('INVALID_HANDSHAKE','主机握手与当前通道不匹配');
    const publicBytes=unb64(hello.hostPublicKey),fingerprint=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',publicBytes)));if(fingerprint!==hello.fingerprint)throw new ChannelError('INVALID_HANDSHAKE','主机指纹与公钥不匹配');
    const pinned=this.pins.get(this.hostId);if(pinned&&pinned!==fingerprint)throw new ChannelError('HOST_IDENTITY_CHANGED','执行主机身份指纹已变化，已阻止连接');
    try{
      const identity=await crypto.subtle.importKey('spki',publicBytes,{name:'Ed25519'},false,['verify']);const valid=await crypto.subtle.verify({name:'Ed25519'},identity,unb64(hello.signature),encoder.encode(transcript({hostId:this.hostId,channelId:this.channelId,clientPublicKey:this.hello.clientPublicKey,hostPublicKey:hello.hostPublicKey,hostEphemeralPublicKey:hello.hostEphemeralPublicKey})));if(!valid)throw new Error('invalid signature');
      const hostEphemeral=await crypto.subtle.importKey('raw',unb64(hello.hostEphemeralPublicKey),{name:'ECDH',namedCurve:'P-256'},false,[]);const shared=await crypto.subtle.deriveBits({name:'ECDH',public:hostEphemeral},this.keyPair.privateKey,256),material=await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveBits']);const keys=new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:encoder.encode(this.channelId),info:encoder.encode('polyhedron-channel-v1')},material,512));this.sendKey=await crypto.subtle.importKey('raw',keys.slice(0,32),'AES-GCM',false,['encrypt']);this.receiveKey=await crypto.subtle.importKey('raw',keys.slice(32,64),'AES-GCM',false,['decrypt']);
    }catch(error){if(error instanceof ChannelError)throw error;throw new ChannelError('INVALID_HANDSHAKE','无法验证执行主机的加密握手')}
    if(!pinned)throw new ChannelError('HOST_TRUST_REQUIRED','首次连接必须确认执行主机的完整身份指纹',fingerprint);
  }
  private aad(direction:'b2h'|'h2b'){return encoder.encode(`polyhedron:v1:${this.channelId}:${direction}`)}
  async seal(value:unknown):Promise<SealedFrame>{
    let resolve!:((frame:SealedFrame)=>void),reject!:((error:unknown)=>void);const result=new Promise<SealedFrame>((ok,fail)=>{resolve=ok;reject=fail});
    this.sendChain=this.sendChain.then(async()=>{if(!this.sendKey)throw new ChannelError('CHANNEL_NOT_READY','安全通道尚未建立');const nonce=++this.sendNonce,encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:iv(nonce),additionalData:this.aad('b2h'),tagLength:128},this.sendKey,encoder.encode(JSON.stringify(value))));resolve({v:1,nonce,ciphertext:b64(encrypted)})}).catch(error=>{reject(error)});return result;
  }
  async open(frame:SealedFrame):Promise<any>{if(!this.receiveKey)throw new ChannelError('CHANNEL_NOT_READY','安全通道尚未建立');if(frame?.v!==1||frame.nonce!==this.receiveNonce+1||typeof frame.ciphertext!=='string')throw new ChannelError('CHANNEL_REPLAY','通道 nonce 缺失或已重放');try{const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:iv(frame.nonce),additionalData:this.aad('h2b'),tagLength:128},this.receiveKey,unb64(frame.ciphertext));const value=JSON.parse(decoder.decode(plain));this.receiveNonce=frame.nonce;return value}catch{throw new ChannelError('CHANNEL_AUTH_FAILED','通道消息认证失败')}
  }
}
