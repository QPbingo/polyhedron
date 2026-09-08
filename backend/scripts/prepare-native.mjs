// Some npm versions extract the node-pty prebuilt helper without executable bits.
import {chmodSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
for(const relative of [`../node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,'../node_modules/node-pty/build/Release/spawn-helper']){
 const path=fileURLToPath(new URL(relative,import.meta.url));if(existsSync(path))chmodSync(path,0o755);
}
