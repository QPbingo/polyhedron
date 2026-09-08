import type {Terminal,IDisposable} from '@xterm/xterm';
/**
 * xterm 5.5's public onData mixes keyboard/IME/paste with parser-generated replies.
 * The pinned core emits onUserInput synchronously immediately before the former.
 * Keep this version-specific bridge isolated, and fail closed on library changes.
 * Browser replicas must never duplicate the headless host's protocol replies.
 */
export function onTerminalUserInput(terminal:Terminal,receive:(data:string)=>void,onUnsupported:(message:string)=>void):IDisposable {
 const core=(terminal as unknown as {_core?:{coreService?:{onUserInput?:(fn:()=>void)=>IDisposable}}})._core?.coreService;
 if(!core?.onUserInput){onUnsupported('当前终端版本无法验证输入来源，已保持只读');return {dispose(){}}}
 let fromUser=false;
 const source=core.onUserInput(()=>{fromUser=true});
 const input=terminal.onData(data=>{const allowed=fromUser;fromUser=false;if(allowed)receive(data)});
 return {dispose(){source.dispose();input.dispose()}};
}
