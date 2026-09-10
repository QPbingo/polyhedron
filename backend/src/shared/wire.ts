const MAX_FRAME = 8 * 1024 * 1024;
export function encodeFrame(message:Record<string,unknown>):string|Buffer {
 if (message.type === 'event' && message.event === 'journal' && message.kind === 'pty_output' && typeof message.data === 'string') {
  const {data,...rest}=message,body=Buffer.from(data),metadata={...rest,dataBytes:body.length},header=Buffer.from(JSON.stringify(metadata));
  const size=Buffer.alloc(4);size.writeUInt32BE(header.length);
  return Buffer.concat([size,header,body]);
 }
 return JSON.stringify(message);
}
export function decodeFrame(raw:Buffer|ArrayBuffer|Buffer[],isBinary?:boolean):any {
 const data=Array.isArray(raw)?Buffer.concat(raw):Buffer.from(raw as ArrayBuffer);
 if(data.length>MAX_FRAME)throw new Error('Frame exceeds limit');
 if(isBinary ?? data[0]===0){
  if(data.length<4)throw new Error('Truncated frame');
  const size=data.readUInt32BE(0);if(size<2||size>16384||size+4>data.length)throw new Error('Invalid header');
  const metadata=JSON.parse(data.subarray(4,4+size).toString());
  const body=data.subarray(4+size);
  if(metadata.type!=='event'||metadata.event!=='journal'||metadata.kind!=='pty_output'||!Number.isSafeInteger(metadata.offset)||metadata.offset<1||!Number.isSafeInteger(metadata.runtimeOffset)||metadata.runtimeOffset<1||!Number.isSafeInteger(metadata.dataBytes)||metadata.dataBytes!==body.length)throw new Error('Invalid binary offset event');
  const {dataBytes:_,...event}=metadata;
  return {...event,data:new TextDecoder('utf-8',{fatal:true}).decode(body)};
 }
 return JSON.parse(data.toString('utf8'));
}
