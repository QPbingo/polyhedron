export type Agent = 'codex' | 'claude';
export type Activity = 'working' | 'approval' | 'idle' | 'done' | 'unknown';
export type ProcessState = 'starting' | 'running' | 'exited' | 'interrupted' | 'failed';
export type JournalState = 'ready' | 'unavailable' | 'integrity_failed';
export interface AgentInfo { id: Agent; name: string; path: string | null; version: string | null; available: boolean; reason?: string; hooks?: boolean }
export interface Host { id: string; name: string; online: boolean; platform?: string; agents?: AgentInfo[]; roots?: string[]; settings?:{preventSleep:boolean;historyDays:number;maxHistoryBytes:number} }
export interface Project { id: string; hostId: string; name: string; path: string; createdAt: string }
export interface Session { id: string; hostId: string; projectId: string; title: string; agent: Agent; processState: ProcessState; activity: Activity; runtimeEpoch: string; nativeSessionId: string | null; controlEpoch: number; controller: string | null; cols: number; rows: number; createdAt: string; updatedAt: string; archived: boolean; exitCode?: number | null; statusSource?: string; warning?: string | null; runtimeOffset?:number; controlOffset?:number|null; headOffset?:number; journalState?:JournalState }
export interface Snapshot {session: Session;seq: number;data: string;cols: number;rows: number;truncated?: boolean}
export interface JournalEvent {type:'event';event:'journal';kind:string;hostId:string;sessionId:string;clientId?:string;offset:number;runtimeOffset:number;data?:string;session?:Session;payload?:Record<string,unknown>}
export interface SessionSnapshot {session:Session;baseOffset:number;headOffset:number;data:string;cols:number;rows:number;truncated?:boolean;events?:JournalEvent[]}
export interface OperationRequest {operationId:string;channelId:string;runtimeOffset?:number;controlOffset?:number|null}
export interface OperationResult<T=unknown> {operationId:string;status:'applied'|'failed'|'indeterminate';offset:number;result?:T;error?:AppError}
export interface HostConfig {hostId:string;accountId:string;hostToken:string;ipcToken:string;relayUrl:string;name:string;roots:string[];dataDir?:string;maxHistoryBytes?:number;historyDays?:number;maxSessions?:number;preventSleep?:boolean;keychain?:boolean}
export interface Rpc {type:'rpc';requestId:string;clientId:string;grant:string;method:string;params:Record<string,unknown>}
export interface AppError {code:string;message:string}
export class Fault extends Error { constructor(public code:string,message:string) { super(message); } }
export function safeError(error:unknown):AppError {return error instanceof Fault?{code:error.code,message:error.message}:{code:'INTERNAL',message:'操作失败，请检查服务诊断日志'};}
