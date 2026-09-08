export type Agent = 'codex' | 'claude';
export type Activity = 'working' | 'approval' | 'idle' | 'done' | 'unknown';
export type ProcessState = 'starting' | 'running' | 'exited' | 'interrupted' | 'failed';
export interface AgentInfo { id: Agent; name: string; path: string | null; version: string | null; available: boolean; reason?: string; hooks?: boolean }
export interface Host { id: string; name: string; online: boolean; platform?: string; agents?: AgentInfo[]; roots?: string[]; settings?:{preventSleep:boolean;historyDays:number;maxHistoryBytes:number} }
export interface Project { id: string; hostId: string; name: string; path: string; createdAt: string }
export interface Session { id: string; hostId: string; projectId: string; title: string; agent: Agent; processState: ProcessState; activity: Activity; runtimeEpoch: string; nativeSessionId: string | null; controlEpoch: number; controller: string | null; cols: number; rows: number; createdAt: string; updatedAt: string; archived: boolean; exitCode?: number | null; statusSource?: string; warning?: string | null }
export interface Snapshot {session: Session;seq: number;data: string;cols: number;rows: number;truncated?: boolean}
export interface HostConfig {hostId:string;accountId:string;hostToken:string;ipcToken:string;relayUrl:string;name:string;roots:string[];dataDir?:string;maxHistoryBytes?:number;historyDays?:number;maxSessions?:number;preventSleep?:boolean;keychain?:boolean}
export interface Rpc {type:'rpc';requestId:string;clientId:string;grant:string;method:string;params:Record<string,unknown>}
export interface AppError {code:string;message:string}
export class Fault extends Error { constructor(public code:string,message:string) { super(message); } }
export function safeError(error:unknown):AppError {return error instanceof Fault?{code:error.code,message:error.message}:{code:'INTERNAL',message:'操作失败，请检查服务诊断日志'};}
