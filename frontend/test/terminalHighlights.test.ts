import test from 'node:test';
import assert from 'node:assert/strict';
import {promptRows} from '../src/terminalHighlights.ts';
function buffer(lines:{text:string;wrapped?:boolean}[],viewportY=0){return {viewportY,length:lines.length,getLine:(i:number)=>lines[i]?{isWrapped:!!lines[i].wrapped,translateToString:()=>lines[i].text}:undefined}}
test('prompt highlights include wrapped input, not quotes or model output',()=>{
 const b=buffer([{text:'› user request'},{text:'wrapped input',wrapped:true},{text:'model answer'},{text:'> quoted answer'},{text:'❯ claude request'},{text:'› fake prompt inside wrap',wrapped:true}]);
 assert.deepEqual(promptRows(b,10,'codex'),[0,1]);assert.deepEqual(promptRows(b,10,'claude'),[4,5]);
});
test('scrolling into wrapped input preserves highlighting and repaint clears it',()=>{
 assert.deepEqual(promptRows(buffer([{text:'› request'},{text:'continuation',wrapped:true},{text:'answer'}],1),2,'codex'),[0]);
 assert.deepEqual(promptRows(buffer([{text:'answer'},{text:'continuation',wrapped:true}]),2,'codex'),[]);
});
