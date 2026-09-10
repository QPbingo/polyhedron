export type Agent = 'codex' | 'claude';
export interface AgentInfo {id:Agent;name:string;path:string|null;version:string|null;available:boolean;reason?:string;hooks?:boolean}
export interface HostSettings {preventSleep:boolean;historyDays:number;maxHistoryBytes:number}
export interface StorageUsage {totalBytes:number;warning:boolean;maxHistoryBytes:number;historyDays:number;oldestAt:string|null}
export interface Host {settings?:HostSettings;storage?:StorageUsage;id:string;name:string;online:boolean;recoveryRequired?:boolean;platform?:string;agents?:AgentInfo[];roots?:string[]}
export interface Project {id:string;hostId:string;name:string;path:string;createdAt:string}
export type JournalState='ready'|'unavailable'|'integrity_failed';
export interface Session {id:string;hostId:string;projectId:string;title:string;agent:Agent;processState:'starting'|'running'|'exited'|'interrupted'|'failed';activity:'working'|'approval'|'idle'|'done'|'unknown';nativeSessionId:string|null;controller:string|null;cols:number;rows:number;createdAt:string;updatedAt:string;archived:boolean;runtimeOffset:number;controlOffset:number|null;headOffset:number;journalState:JournalState;historyBytes?:number;exitCode?:number|null;statusSource?:string;warning?:string|null}
export interface State {hosts:Host[];projects:Project[];sessions:Session[]}
export interface JournalEvent {type:'event';event:'journal';kind:string;hostId:string;sessionId:string;clientId?:string;channelId?:string;offset:number;runtimeOffset:number;data?:string;session?:Session;payload?:Record<string,unknown>}
export interface SessionSnapshot {session:Session;baseOffset:number;headOffset:number;data:string;cols:number;rows:number;truncated?:boolean;events?:JournalEvent[]}
export interface History {runs?:{runtimeOffset:number;createdAt:string}[];runsHasMore?:boolean;entries:{offset:number;data:string;at:string}[];hasMore:boolean;truncated:boolean;runtimeOffset:number}
export interface Auth {authenticated:boolean;user?:{id:string;name:string};csrfToken?:string;mode:'development'|'oidc'}
export const active = (session:Session) => session.processState==='running'||session.processState==='starting';
export const agentName = (agent:Agent) => agent==='codex'?'Codex':'Claude Code';
export function statusName(session:Session) {if(session.journalState!=='ready')return session.journalState==='integrity_failed'?'记录完整性异常':'本地记录不可用';if(!active(session))return ({exited:'已结束',interrupted:'已中断',failed:'启动失败'} as Record<string,string>)[session.processState]||session.processState;return ({working:'运行中',approval:'等待审批',idle:'等待输入',done:'本轮结束',unknown:'状态未知'})[session.activity]}
export interface BrowserLogin {id:string;createdAt:number;expiresAt:number;current:boolean}
