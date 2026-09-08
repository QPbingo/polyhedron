const MAX_FRAME = 8 * 1024 * 1024;
export function encodeFrame(message:Record<string,unknown>):string|Buffer {
 if (message.type === 'event' && message.event === 'output' && typeof message.data === 'string') {
  const {data,...metadata}=message, header=Buffer.from(JSON.stringify(metadata));
  const size=Buffer.alloc(4);size.writeUInt32BE(header.length);
  return Buffer.concat([size,header,Buffer.from(data)]);
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
  if(metadata.type!=='event'||metadata.event!=='output')throw new Error('Invalid binary event');
  return {...metadata,data:data.subarray(4+size).toString('utf8')};
 }
 return JSON.parse(data.toString('utf8'));
}
