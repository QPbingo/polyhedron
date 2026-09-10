export type Agent = 'codex' | 'claude';
export interface AgentInfo {id:Agent;name:string;path:string|null;version:string|null;available:boolean;reason?:string;hooks?:boolean}
export interface HostSettings {preventSleep:boolean;historyDays:number;maxHistoryBytes:number}
export interface Host {settings?:HostSettings;id:string;name:string;online:boolean;platform?:string;agents?:AgentInfo[];roots?:string[]}
export interface Project {id:string;hostId:string;name:string;path:string;createdAt:string}
export type JournalState='ready'|'unavailable'|'integrity_failed';
export interface Session {id:string;hostId:string;projectId:string;title:string;agent:Agent;processState:'starting'|'running'|'exited'|'interrupted'|'failed';activity:'working'|'approval'|'idle'|'done'|'unknown';runtimeEpoch:string;nativeSessionId:string|null;controlEpoch:number;controller:string|null;cols:number;rows:number;createdAt:string;updatedAt:string;archived:boolean;exitCode?:number|null;statusSource?:string;warning?:string|null;runtimeOffset?:number;controlOffset?:number|null;headOffset?:number;journalState?:JournalState}
export interface State {hosts:Host[];projects:Project[];sessions:Session[]}
export interface Snapshot {session:Session;seq:number;data:string;cols:number;rows:number;truncated?:boolean}
export interface Output {type:'event';event:'output';hostId:string;sessionId:string;clientId:string;runtimeEpoch:string;seq:number;data:string}
export interface JournalEvent {type:'event';event:'journal';kind:string;hostId:string;sessionId:string;clientId?:string;offset:number;runtimeOffset:number;data?:string;session?:Session;payload?:Record<string,unknown>}
export interface SessionSnapshot {session:Session;baseOffset:number;headOffset:number;data:string;cols:number;rows:number;truncated?:boolean;events?:JournalEvent[]}
export interface History {runs?:{runtimeEpoch:string;createdAt:string}[];entries:{seq:number;data:string;at:string}[];hasMore:boolean;truncated:boolean;runtimeEpoch:string}
export interface Auth {authenticated:boolean;user?:{id:string;name:string};csrfToken?:string;mode:'development'|'oidc'}
export const active = (s:Session) => s.processState==='running'||s.processState==='starting';
export const agentName = (a:Agent) => a==='codex'?'Codex':'Claude Code';
export function statusName(s:Session) {if(!active(s))return ({exited:'已结束',interrupted:'已中断',failed:'启动失败'} as Record<string,string>)[s.processState]||s.processState;return ({working:'运行中',approval:'等待审批',idle:'等待输入',done:'本轮结束',unknown:'状态未知'})[s.activity]}

export interface BrowserLogin {id:string;createdAt:number;expiresAt:number;current:boolean}
