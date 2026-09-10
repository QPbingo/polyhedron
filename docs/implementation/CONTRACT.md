# Host-authoritative implementation contract

This contract reflects the approved host-authoritative journal design. `demos/` remains a standalone visual reference. The browser never owns session truth, the Connector never queues executable content, and Relay never stores or interprets session content.

## Processes and authority

- Frontend Vite listens on `127.0.0.1:18417` and proxies `/api`, `/auth` and `/ws` to Relay in development.
- Relay authenticates browser accounts, stores Host bindings and routes opaque channel envelopes. Production requires OIDC, PostgreSQL and HTTPS/WSS.
- Connector joins one outbound Relay WebSocket to the authenticated local Host Unix-socket WebSocket. Loss of either side closes the pair; it does not replay frames.
- Session Host owns PTYs, Agent processes, directory authorization, the headless terminal, control ownership, history and the only authoritative per-session offset.

Relay persistence is limited to accounts, hashed browser logins, encrypted Host credentials, pairings, OIDC state and content-free security audit metadata. It contains no project/session projection, path, title, native ID, controller, input, output, Hook, snapshot or history content.

## Public session and offset types

```ts
type JournalState = 'ready' | 'unavailable' | 'integrity_failed'
interface Session {
  id:string; hostId:string; projectId:string; title:string; agent:'codex'|'claude';
  processState:'starting'|'running'|'exited'|'interrupted'|'failed';
  activity:'working'|'approval'|'idle'|'done'|'unknown';
  nativeSessionId:string|null; controller:string|null;
  cols:number; rows:number; createdAt:string; updatedAt:string; archived:boolean;
  runtimeOffset:number; controlOffset:number|null; headOffset:number; journalState:JournalState;
}
interface JournalEvent {
  type:'event'; event:'journal'; kind:string; hostId:string; sessionId:string;
  clientId?:string; channelId?:string; offset:number; runtimeOffset:number;
  data?:string; session?:Session;
}
interface SessionSnapshot {
  session:Session; baseOffset:number; headOffset:number; data:string;
  cols:number; rows:number; truncated?:boolean; events?:JournalEvent[];
}
```

Every committed session fact gets exactly one strictly increasing `offset`. `runtimeOffset` is the offset of `runtime_started`; `controlOffset` is the offset of `control_acquired`. There is no browser-facing runtime epoch, control epoch, input sequence or output sequence. Transport nonce, heartbeat and ACK state do not consume journal offsets.

## REST and opaque WebSocket transport

Relay REST:

- `GET /api/auth`, development/OIDC login and `POST /auth/logout` manage HttpOnly browser sessions.
- `GET /api/hosts` returns only owned Host bindings and live status.
- Compatibility `GET /api/state` returns those Hosts plus `projects:[]` and `sessions:[]`.
- `GET /api/browsers` and `POST /api/browsers/:id/revoke` manage independently revocable browser logins.
- Pairing start/poll/approve and Host revocation preserve account ownership, rate, Origin and CSRF boundaries.

`/ws/browser` accepts only `open_channel` and `sealed`; `/ws/host` accepts only channel open/renew/close plus sealed result/event routing. Plaintext RPC, result, state or terminal frames are rejected. Relay outer envelopes contain routing IDs, channel grant/public handshake material or ciphertext only.

## End-to-end channel

The browser generates a fresh P-256 ECDH key and random channel ID. Relay issues a <=30-second HS256 grant bound to account subject, Host, client instance, channel, purpose and the opening client public key. Host verifies the grant and replies with an ephemeral P-256 key plus an Ed25519 signature from its encrypted long-term identity. Both sides derive directional AES-256-GCM keys with HKDF-SHA256.

Each direction enforces a strictly sequential authenticated nonce. Tampering, gaps, replay, wrong channel and unsealed content close the channel. Channel IDs are single-use through their authorization lifetime plus a bounded 30-second replay window; reconnect always generates a cryptographically random new ID. Browser TOFU pins only the Host public-key fingerprint in localStorage; a changed identity fails with `HOST_IDENTITY_CHANGED`. No terminal or session content is stored in browser persistence.

## Durable operation protocol

Every browser request carries a random `operationId` inside the sealed body. Authenticated Host operations follow:

1. Validate identity and bounded request shape.
2. Commit `*_requested` in the encrypted local journal.
3. Execute the PTY/process/read side effect once.
4. Atomically commit the applied, failed or indeterminate result and materialized session state.
5. Only then return or broadcast the result.

Exact retries by stream, authenticated device actor, operation ID, kind and payload digest return the durable result even after a fresh channel is established. Collisions reject. Requested operations left unfinished by a Host crash recover as `operation_indeterminate` and are never automatically replayed. Input audit stores only byte length and digest; visible prompts enter history only through committed PTY echo.

Key Host methods are `list`, `listDirectories`, Host/project/session mutations, `attach`, `detach`, `claimControl`, `input`, `resize`, `interrupt`, `terminate`, `resume`, `archive`, `history` and transport-only `eventAck`. Control operations require matching `sessionId`, `runtimeOffset`, `controlOffset` and current channel ownership. Attach is always read-only. Reconnect creates a fresh channel and requires a new explicit claim.

## Output, snapshots and recovery

PTY output is committed as `pty_output` before parsing or broadcast. The same serialized writer orders operations, output, lifecycle and normalized Hook facts. Browser clients install a Host snapshot at `baseOffset`, then apply its continuous tail and live events. Duplicates are ignored; the first gap stops rendering and causes reattach. `eventAck(appliedOffset)` is sent only after xterm finishes applying the event.

The Host keeps encrypted SQLite domain rows, journal events, operation results and snapshots under one database with WAL, `synchronous=FULL`, foreign keys and application HMAC event chains. History is permanent until the user explicitly deletes its session; day/byte settings are warning thresholds only. A corrupt/missing terminal snapshot is rebuilt from current-runtime journal output. A corrupt journal chain or unavailable key fails startup/operation closed.

If a journal commit fails, remote history and controls stop, uncommitted output is not broadcast, and PTY reading is paused without automatically killing the Agent. A Host restart cannot retain the old PTY descriptor: it records `runtime_interrupted`, clears channel control and requires explicit native-session recovery when a verified native ID exists.

## Hook and native Agent boundary

`buildLaunch` receives a random in-memory `runtimeToken` used only to correlate authenticated local Hook calls; it is not an ordering counter. The bridge submits only bounded identifiers and normalized event metadata over authenticated Unix HTTP. Prompt, tool arguments/results, transcript paths and model content are discarded by the bridge. Hook dedupe, native-session binding and materialized activity update commit atomically in the Host journal.

## Explicit security limits

The design protects content from Relay persistence and passive Relay inspection, but Relay remains the authorization trust boundary. First-use TOFU cannot prove a Host identity against an actively malicious Relay without out-of-band fingerprint verification; moreover, because Relay possesses the Host grant credential, an actively compromised Relay can authorize its own client channel and issue operations even after an honest browser has pinned the real Host. Closing that gap requires a Host-registered account/device signing root or explicit Host-local device approval. The local HMAC chain detects modification/reordering relative to its retained head but cannot prove that both database and Keychain material were not rolled back together by a Host administrator. Logical terminal state is identical at the same geometry and applied offset; OS font rasterization is outside the guarantee.
