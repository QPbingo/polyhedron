import type {Terminal,IDisposable} from '@xterm/xterm';
type BufferView={viewportY:number;length:number;getLine:(index:number)=>{isWrapped:boolean;translateToString:(trim?:boolean)=>string}|undefined};

// Presentation only: recognize native prompt glyphs, not arbitrary shell '>'
// or a semantic chat transcript. Unknown lines retain their original appearance.
export function promptRows(buffer:BufferView,rows:number,agent:'codex'|'claude'):number[]{
 const pattern=agent==='codex'?/^\s{0,3}›(?:\s|$)/:/^\s{0,3}❯(?:\s|$)/;
 let start=buffer.viewportY;
 // A visible wrapped line can belong to an input that starts above the viewport.
 while(start>0&&buffer.getLine(start)?.isWrapped&&buffer.viewportY-start<1000)start--;
 const result:number[]=[];let input=false;
 for(let i=start;i<Math.min(buffer.length,buffer.viewportY+rows);i++){
  const line=buffer.getLine(i);if(!line){input=false;continue}
  if(!line.isWrapped)input=pattern.test(line.translateToString(true));
  if(input&&i>=buffer.viewportY)result.push(i-buffer.viewportY);
 }
 return result;
}

export function highlightTerminalInputs(term:Terminal,agent:'codex'|'claude'):IDisposable {
 const screen=term.element?.querySelector<HTMLElement>('.xterm-screen');if(!screen)return {dispose(){}};
 const layer=document.createElement('div');layer.className='terminal-input-highlights';layer.setAttribute('aria-hidden','true');screen.append(layer);
 let frame=0,disposed=false,signature='';
 const paint=()=>{
  frame=0;if(disposed)return;
  const rows=promptRows(term.buffer.active,term.rows,agent),height=screen.clientHeight/term.rows;
  const next=`${height}:${rows.join(',')}`;if(next===signature)return;signature=next;
  layer.replaceChildren(...rows.map(row=>{const element=document.createElement('div');element.className='terminal-input-row';element.style.top=`${row*height}px`;element.style.height=`${height}px`;return element}));
 };
 const schedule=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(paint)};
 const subscriptions=[term.onWriteParsed(schedule),term.onScroll(schedule),term.onResize(schedule),term.onRender(schedule)];
 const observer=new ResizeObserver(schedule);observer.observe(screen);schedule();
 return {dispose(){disposed=true;cancelAnimationFrame(frame);observer.disconnect();subscriptions.forEach(s=>s.dispose());layer.remove()}};
}
