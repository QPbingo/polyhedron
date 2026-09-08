import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const exec=promisify(execFile);
test('macOS package rejects implicit or Homebrew-linked Node before starting a build',{skip:process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'poly-package-'));
 try {
  // Stop any accidental old-script build immediately; never create a real package in this boundary test.
  await writeFile(join(dir,'npm'),'#!/bin/sh\necho unexpected-build >&2\nexit 99\n');await chmod(join(dir,'npm'),0o700);
  const env={...process.env,PATH:dir+':/usr/bin:/bin',PACKAGE_OUTPUT:join(dir,'output')};delete env.NODE_BINARY;
  await assert.rejects(exec('/bin/bash',[resolve('scripts/build-macos-package.sh')],{env}),error=>/NODE_BINARY is required/.test(String((error as any).stderr)));
  await assert.rejects(exec('/bin/bash',[resolve('scripts/build-macos-package.sh')],{env:{...env,NODE_BINARY:'/opt/homebrew/bin/node'}}),error=>/non-system dynamic library/.test(String((error as any).stderr)));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('portable Node downloader rejects invalid release paths, architectures, and existing destinations before network access',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'poly-node-download-test-'));
 try{
  for(const args of [['--version','../../secrets'],['--arch','../arm64']]) await assert.rejects(exec(process.execPath,[resolve('scripts/download-node.mjs'),'--output',join(dir,'new'),...args]),error=>/exact Node 24 version|Architecture must/.test(String((error as any).stderr)));
  await assert.rejects(exec(process.execPath,[resolve('scripts/download-node.mjs'),'--output',dir]),error=>/Output already exists/.test(String((error as any).stderr)));
 }finally{await rm(dir,{recursive:true,force:true});}
});
