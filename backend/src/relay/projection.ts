import {z} from 'zod';

const id=z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const timestamp=z.string().datetime({offset:true});
const projectFields=z.object({id,name:z.string().max(200),createdAt:timestamp});
const sessionFields=z.object({
  id,projectId:id,title:z.string().max(200),agent:z.enum(['codex','claude']),
  processState:z.enum(['starting','running','exited','interrupted','failed']),
  activity:z.enum(['working','approval','idle','done','unknown']).default('unknown'),
  runtimeEpoch:id,controlEpoch:z.number().int().nonnegative(),
  cols:z.number().int().min(1).max(400).default(100),rows:z.number().int().min(1).max(200).default(30),
  createdAt:timestamp,updatedAt:timestamp,archived:z.boolean().default(false),
  exitCode:z.number().int().nullable().optional(),
});
export interface HostProjection {projects:Record<string,any>[];sessions:Record<string,any>[]}
/** Construct new allowlisted objects, never spread host-controlled source records. */
export function projectSummary(hostId:string,input:unknown){const result=projectFields.safeParse(input);return result.success?{...result.data,hostId}:null;}
export function sessionSummary(hostId:string,input:unknown){const result=sessionFields.safeParse(input);return result.success?{...result.data,hostId,nativeSessionId:null,controller:null}:null;}
export function sanitizeProjection(hostId:string,input:unknown):HostProjection{
  const source=input&&typeof input==='object'?input as Record<string,unknown>:{};
  return {
    projects:Array.isArray(source.projects)?source.projects.map(p=>projectSummary(hostId,p)).filter((p):p is NonNullable<typeof p>=>p!==null):[],
    sessions:Array.isArray(source.sessions)?source.sessions.map(s=>sessionSummary(hostId,s)).filter((s):s is NonNullable<typeof s>=>s!==null):[],
  };
}
