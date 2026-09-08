#!/usr/bin/env node
// Downloads only official Node distribution artifacts; no install, package build, or global writes.
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,mkdir,rm,rename,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';

const {values}=parseArgs({options:{version:{type:'string'},arch:{type:'string',default:process.arch},output:{type:'string'}}});
if(!values.output)throw new Error('Usage: node scripts/download-node.mjs --output NEW_DIRECTORY [--version v24.x.y] [--arch arm64|x64]');
if(!['arm64','x64'].includes(values.arch))throw new Error('Architecture must be arm64 or x64');
if(values.version&&!/^v24\.\d+\.\d+$/.test(values.version))throw new Error('Choose an exact Node 24 version such as v24.14.0');
const destination=resolve(values.output);
try{await access(destination);throw new Error('Output already exists; choose a new directory');}catch(error){if(error.code!=='ENOENT')throw error;}
async function official(relative,maxBytes){
 const url=new URL(relative,'https://nodejs.org/dist/');
 if(url.origin!=='https://nodejs.org'||!url.pathname.startsWith('/dist/'))throw new Error('Invalid official download path');
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
 if(!response.ok||!response.body)throw new Error(`Official Node download failed (${response.status})`);
 let length=0;const chunks=[];
 for await(const chunk of response.body){length+=chunk.length;if(length>maxBytes)throw new Error('Official download exceeded size limit');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
// Latest alias is used only to discover a concrete immutable version; the archive and checksum are pinned below.
let version=values.version;
if(!version){
 const latest=(await official('latest-v24.x/SHASUMS256.txt',1024*1024)).toString('utf8');
 const matches=[...latest.matchAll(/^([a-f0-9]{64})\s+(node-(v24\.\d+\.\d+)-darwin-(arm64|x64)\.tar\.gz)$/gm)].filter(m=>m[4]===values.arch);
 if(matches.length!==1)throw new Error('Could not identify a unique official Node 24 macOS archive');
 version=matches[0][3];
}
const basename=`node-${version}-darwin-${values.arch}`,archive=`${basename}.tar.gz`;
const checksumText=(await official(`${version}/SHASUMS256.txt`,1024*1024)).toString('utf8');
const line=checksumText.split('\n').find(line=>line.trim().split(/\s+/)[1]===archive);
const expected=line?.trim().split(/\s+/)[0];
if(!expected||!/^([a-f0-9]{64})$/.test(expected))throw new Error('Archive missing from official SHASUMS256');
const bytes=await official(`${version}/${archive}`,128*1024*1024);
const actual=createHash('sha256').update(bytes).digest('hex');
if(actual!==expected)throw new Error('Official Node SHA-256 checksum mismatch');
await mkdir(dirname(destination),{recursive:true});
const staging=await mkdtemp(join(dirname(destination),'.poly-node-download-'));
try{
 const archivePath=join(staging,archive);await writeFile(archivePath,bytes,{mode:0o600});
 const entries=execFileSync('/usr/bin/tar',['-tzf',archivePath],{encoding:'utf8',maxBuffer:16*1024*1024}).split('\n').filter(Boolean);
 if(entries.some(name=>!name.startsWith(basename+'/')||name.split('/').includes('..')))throw new Error('Invalid archive paths');
 execFileSync('/usr/bin/tar',['-xzf',archivePath,'-C',staging],{stdio:'pipe'});
 await rename(join(staging,basename),destination);
 await writeFile(join(destination,'polyhedron-download.json'),JSON.stringify({version,architecture:values.arch,url:`https://nodejs.org/dist/${version}/${archive}`,sha256:actual,checksumUrl:`https://nodejs.org/dist/${version}/SHASUMS256.txt`},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({version,architecture:values.arch,nodeBinary:join(destination,'bin/node'),sha256:actual},null,2));
}finally{await rm(staging,{recursive:true,force:true});}
