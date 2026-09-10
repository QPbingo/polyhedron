# Host-Authoritative Session Journal Implementation Plan

**Status:** Implemented and verified on 2026-09-11. Evidence is recorded in `docs/implementation/VERIFICATION.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the split sequence/projection model with a host-only durable event journal, one writable encrypted browser channel per session, offset-based recovery, and end-to-end verified multi-browser control.

**Architecture:** The Session Host owns one encrypted SQLite database and assigns every session fact a monotonically increasing offset. Browser RPC and events travel inside an application-layer encrypted channel through an opaque Relay; the Relay retains only account/host routing metadata. Every authenticated operation is recorded before its effect, every result/output is committed before acknowledgement or broadcast, and every browser reconnects readonly and rebuilds from snapshot plus journal tail.

**Tech Stack:** Node.js 22, TypeScript 5.9, `node:sqlite`, `node:crypto`, `jose`, Fastify/WebSocket, node-pty, xterm/headless 5.5, React 19, Web Crypto, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-11-host-authoritative-session-journal-design.md`

## Global Constraints

- Work directly on `main` because the user explicitly requested direct integration; do not create a feature branch.
- Keep Agent processes, terminal content, project paths, native session IDs, snapshots, control state, and history exclusively authoritative on the execution host.
- Relay persistence may contain account/device/host binding, public host identity, revocation, routing, and content-free security audit metadata only.
- Use one per-session signed 64-bit `offset`; do not introduce replacement runtime/input/output ordering counters.
- A browser reconnect creates a fresh encrypted channel and is readonly until an explicit claim succeeds.
- Do not execute a PTY/process side effect before its request record commits; do not acknowledge or broadcast a result/output before its result event commits.
- Unknown delivery is surfaced as `OPERATION_INDETERMINATE` and is never automatically replayed.
- Journal failure is fail-closed for attach/history/control and applies PTY backpressure without killing the Agent automatically.
- Journal history is retained until an explicit user deletion; remove automatic history age/quota pruning.
- Use tests first and observe each new test fail for the intended missing behavior before production changes.
- Do not claim pixel-identical font rasterization across OSes; verify identical logical terminal state at the same offset and geometry.

---

### Task 1: Define the offset protocol and operation contracts

**Files:**
- Modify: `backend/src/shared/types.ts`
- Modify: `backend/src/shared/wire.ts`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/protocol.ts`
- Test: `backend/test/wire.test.ts`
- Test: `frontend/test/protocol.test.ts`

**Interfaces:**
- Produces: `Session.runtimeOffset`, `Session.controlOffset`, `Session.headOffset`, `Session.journalState`.
- Produces: `JournalEvent`, `TerminalOutputEvent`, `SessionSnapshot`, `OperationRequest` and `OperationResult` wire types.
- Produces: `OffsetCursor.push(event)` and `OffsetCursor.installSnapshot(baseOffset, queuedEvents)` for all event ordering.
- Removes: browser-facing `runtimeEpoch`, `controlEpoch`, `inputSeq`, output `seq`, and `OutputCursor`.

- [x] **Step 1: Write failing backend wire tests**

Add literal fixtures proving binary output frames round-trip `offset`, `runtimeOffset`, `sessionId`, `clientId` and UTF-8 bytes; reject missing/negative offsets, legacy `seq` frames, trailing binary bytes beyond the declared body, and frames over 8 MiB.

```ts
const event = {type:'event', event:'journal', kind:'pty_output', hostId:'h', sessionId:'s', clientId:'c', offset:7, runtimeOffset:2, data:'你好'};
assert.deepEqual(decodeFrame(encodeFrame(event) as Buffer, true), event);
assert.throws(() => decodeFrame(legacySeqFrame, true), /offset/i);
```

- [x] **Step 2: Run the wire test and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='offset binary'`

Expected: FAIL because current frames require `event:'output'` and `seq`.

- [x] **Step 3: Write failing frontend offset cursor tests**

Cover duplicate suppression, a gap raising `OFFSET_GAP`, buffering before a snapshot, rejecting another runtime, and applying non-render events while still advancing `appliedOffset`.

```ts
const cursor = new OffsetCursor();
assert.deepEqual(cursor.installSnapshot(4, [{offset:3,kind:'pty_output',data:'old'}]), []);
assert.deepEqual(cursor.push({offset:5,kind:'pty_output',data:'next'}), [{offset:5,kind:'pty_output',data:'next'}]);
assert.throws(() => cursor.push({offset:7,kind:'pty_output',data:'gap'}), /OFFSET_GAP/);
```

- [x] **Step 4: Run the frontend protocol test and verify RED**

Run: `cd frontend && npm run test:unit -- --test-name-pattern='offset cursor'`

Expected: FAIL because `OffsetCursor` and offset-based types do not exist.

- [x] **Step 5: Implement the shared contracts and frame validation**

Use these public shapes consistently in backend and frontend:

```ts
interface Session {
  runtimeOffset:number;
  controlOffset:number|null;
  headOffset:number;
  controller:string|null;
  journalState:'ready'|'unavailable'|'integrity_failed';
}
interface JournalEvent {
  type:'event'; event:'journal'; kind:string;
  hostId:string; sessionId:string; clientId?:string;
  offset:number; runtimeOffset:number; data?:string;
  session?:Session; payload?:Record<string,unknown>;
}
interface SessionSnapshot {
  session:Session; baseOffset:number; headOffset:number;
  data:string; cols:number; rows:number; truncated?:boolean;
}
```

Encode only `kind:'pty_output'` as a binary body; require the body length to equal the remaining frame exactly. `OffsetCursor` buffers at most 2 MiB before snapshot, drops `offset <= appliedOffset`, and stops on the first gap.

- [x] **Step 6: Run focused and type tests**

Run: `cd backend && npm test -- --test-name-pattern='offset binary' && npm run typecheck`

Run: `cd frontend && npm run test:unit -- --test-name-pattern='offset cursor' && npm run typecheck`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add backend/src/shared/types.ts backend/src/shared/wire.ts backend/test/wire.test.ts frontend/src/types.ts frontend/src/protocol.ts frontend/test/protocol.test.ts
git commit -m "feat(protocol): unify session events by offset"
```

### Task 2: Build the encrypted SQLite journal and migrate legacy local data

**Files:**
- Create: `backend/src/host/crypto.ts`
- Create: `backend/src/host/journal.ts`
- Modify: `backend/src/host/store.ts`
- Test: `backend/test/host-journal.test.ts`
- Test: `backend/test/host-migration.test.ts`

**Interfaces:**
- `LocalCipher(secret:string, hostId:string)` exposes `sealJson`, `openJson`, `digest`, `eventHash`.
- `HostJournal.begin(input): BeginResult`, `HostJournal.complete(handle,input): JournalEvent`, `HostJournal.appendFact(input): JournalEvent`, `HostJournal.recover(): RecoveryReport`.
- `HostStore` owns one `DatabaseSync`, encrypted domain rows, journal, snapshots and history.
- Fault injection interface: `{hit(point: JournalFaultPoint): void}` with named commit boundaries used only through dependency injection.

- [x] **Step 1: Write failing journal durability and privacy tests**

Use a real temporary SQLite database. Assert `PRAGMA journal_mode` is `wal`, `PRAGMA synchronous` is `2`, offsets are contiguous, operation IDs deduplicate exact requests, collisions reject, encrypted payloads contain no literal prompt/path, and reopening with the same host secret decrypts records.

```ts
const first = store.journal.begin({streamId:'session:s',operationId:'op-1',actor:'c',kind:'input',payload:{data:'TOP SECRET'}});
store.journal.complete(first.handle,{kind:'input_applied',result:{accepted:true}});
assert.equal(store.journal.eventsAfter('session:s',0)[0].offset,1);
assert.doesNotMatch(readFileSync(dbPath).toString('latin1'),/TOP SECRET/);
```

- [x] **Step 2: Run journal tests and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='encrypted journal'`

Expected: FAIL because the journal API and encrypted schema do not exist.

- [x] **Step 3: Implement crypto and journal schema**

Derive a host wrapping key with HKDF-SHA256 from the Keychain-backed host token and host ID. Generate a per-session DEK, wrap it with AES-256-GCM, encrypt sensitive JSON payloads with versioned AES-256-GCM envelopes, and HMAC-chain each event over immutable headers, ciphertext digest and previous hash.

Create `journal_streams`, `journal_events`, `journal_operations`, `session_keys`, encrypted `projects`, encrypted `sessions`, and encrypted `snapshots`. Use explicit `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`; update stream head, event, operation result and materialized session in one transaction. Configure `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000`.

- [x] **Step 4: Write failing migration tests**

Create a legacy database plus JSONL segment, open the new store, and assert it imports the visible output as `legacy_imported`/`pty_output` events, encrypts project/session rows, retains the source files, and rolls back the new migration on a corrupted line.

- [x] **Step 5: Run migration tests and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='legacy journal migration'`

Expected: FAIL because legacy import is not implemented.

- [x] **Step 6: Implement idempotent migration and permanent retention**

Back up/rename legacy tables inside the database, import valid JSONL in deterministic runtime/sequence order, record provenance and checksums, and leave original JSONL untouched. Remove `prune()` deletion; expose storage usage/warning information instead. An import error must rollback the new schema and preserve old data.

- [x] **Step 7: Run the complete store suite**

Run: `cd backend && npm test -- --test-name-pattern='journal|migration|history' && npm run typecheck`

Expected: PASS with no plaintext assertion failures.

- [x] **Step 8: Commit**

```bash
git add backend/src/host/crypto.ts backend/src/host/journal.ts backend/src/host/store.ts backend/test/host-journal.test.ts backend/test/host-migration.test.ts backend/test/host-review.test.ts
git commit -m "feat(host): add encrypted durable session journal"
```

### Task 3: Put every Host operation and Agent fact behind the journal

**Files:**
- Modify: `backend/src/host/manager.ts`
- Modify: `backend/src/host/terminal.ts`
- Modify: `backend/src/adapters/index.ts`
- Modify: `backend/scripts/hook-bridge.mjs`
- Test: `backend/test/host-operations.test.ts`
- Test: `backend/test/host-review.test.ts`
- Test: `backend/test/adapters-hook.test.ts`

**Interfaces:**
- `HostManager.rpc` consumes `operationId`, `channelId`, `runtimeOffset`, and `controlOffset`.
- `withRecordedOperation(context, validate, effect, commit)` is the only path for authenticated non-transport RPC.
- Runtime uses a random internal `runtimeToken` only for Hook correlation; ordering and browser contracts use `runtimeOffset`.
- `appendOutput(runtime,data)` commits `pty_output` before parsing or broadcasting.

- [x] **Step 1: Write failing fail-closed operation tests**

Inject failures at `request.beforeCommit`, `request.afterCommit`, `effect.after`, and `result.beforeCommit` for input, resize, interrupt, terminate, create/resume and history. Assert pre-request failure performs no side effect, post-effect failure sends no success, reopening records indeterminate status, and exact operationId retries never repeat a PTY write.

- [x] **Step 2: Run operation tests and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='records before side effect|indeterminate|journal unavailable'`

Expected: FAIL because current manager writes directly to PTY and broadcasts after storage errors.

- [x] **Step 3: Implement the recorded operation pipeline**

Validate auth and shape first, commit `*_requested`, execute once, commit applied/failed, then return. Use reserved stream `host:<hostId>` for authenticated host/project/configuration operations that have no session; use `session:<sessionId>` for session operations. Transport heartbeat and output acknowledgement bypass the audit journal but cannot mutate session facts.

For create/resume, buffer PTY callbacks until `runtime_started` commits and assign that event's offset to `session.runtimeOffset`. For terminate, `*_applied` means the signal was issued, not that the process exited. For input, preserve only payload digest and byte length in audit metadata.

- [x] **Step 4: Write failing output/parser/Hook tests**

Assert storage failure pauses PTY and broadcasts nothing, a committed output receives its offset before headless parsing, parser failure triggers deterministic replay or integrity failure without skipping bytes, and Hook dedupe plus state projection commit atomically.

- [x] **Step 5: Run output and Hook tests and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='output commits before broadcast|hook state atomically|parser failure'`

Expected: FAIL against the current warning-and-continue behavior.

- [x] **Step 6: Implement output, exit and Hook fact ordering**

Queue PTY callbacks on the same runtime writer, append `pty_output`, parse committed bytes, checkpoint a snapshot at the committed offset, then broadcast. On storage failure pause the PTY and enter `journal_unavailable`; on parser failure rebuild from snapshot plus events and fail closed if replay is not deterministic. Commit runtime exit, controller release and final session state together before emitting state/exit events. Commit Hook event ID, normalized Agent state and native session binding in one transaction.

- [x] **Step 7: Verify Host behavior**

Run: `cd backend && npm test -- --test-name-pattern='host|PTY|hook|journal' && npm run typecheck`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add backend/src/host/manager.ts backend/src/host/terminal.ts backend/src/adapters/index.ts backend/scripts/hook-bridge.mjs backend/test/host-operations.test.ts backend/test/host-review.test.ts backend/test/adapters-hook.test.ts
git commit -m "feat(host): make journal commits precede session effects"
```

### Task 4: Implement readonly attach, atomic snapshot tails and channel-bound control

**Files:**
- Modify: `backend/src/host/manager.ts`
- Modify: `backend/src/shared/types.ts`
- Test: `backend/test/host-control.test.ts`
- Test: `backend/test/host.test.ts`

**Interfaces:**
- Attach input: `{sessionId,lastAppliedOffset,operationId,channelId}`.
- Attach output: `SessionSnapshot` plus a continuous `events` tail and `headOffset`.
- Claim output: committed session with `controlOffset` equal to the `control_acquired` event offset.
- Controller identity: `{deviceId,clientInstanceId,channelId}` internally; UI projection remains an opaque controller ID.

- [x] **Step 1: Write failing attach/control concurrency tests**

Use two real clients and one PTY. Assert attach is readonly, two simultaneous claims yield one latest controlOffset, stale input/resize is rejected and journaled, detach releases only its own channel, a new channel for the same client cannot reuse old controlOffset, and snapshot plus live tail has neither gaps nor duplicates under concurrent output.

- [x] **Step 2: Run control tests and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='channel-bound control|atomic offset attach'`

Expected: FAIL because control currently binds only `clientId` and snapshot uses `seq`.

- [x] **Step 3: Implement channel-bound subscribers and sync watermarks**

Subscriber keys include channelId. Register a buffered subscription at `contentOffset + 1` before returning attach; send `snapshot(baseOffset)` plus committed events through `contentOffset`, then drain the buffered live stream. Control claim commits `control_requested` and `control_acquired`; reconnect never inherits. Detach/liveness timeout commits `control_released` before state broadcast.

- [x] **Step 4: Implement offset ACK/backpressure**

`outputAck` becomes transport `eventAck` with `appliedOffset`. Bound pending event bytes and count per channel; slow observers receive `resync` and detach without affecting the controller or other sessions. Do not put ACK/heartbeat in the journal.

- [x] **Step 5: Run Host and concurrency suites**

Run: `cd backend && npm test -- --test-name-pattern='channel-bound control|atomic offset attach|real PTY' && npm run typecheck`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add backend/src/host/manager.ts backend/src/shared/types.ts backend/test/host-control.test.ts backend/test/host.test.ts
git commit -m "feat(host): bind control and recovery to journal offsets"
```

### Task 5: Remove Relay projections and make its content path opaque

**Files:**
- Delete: `backend/src/relay/projection.ts`
- Modify: `backend/src/relay/store.ts`
- Modify: `backend/src/relay/schema.postgres.sql`
- Modify: `backend/src/relay/app.ts`
- Modify: `backend/src/connector/main.ts`
- Test: `backend/test/relay-store.test.ts`
- Replace: `backend/test/relay-projection.test.ts`
- Test: `backend/test/relay.test.ts`

**Interfaces:**
- `/api/state` returns only owned host bindings and live/offline status, or is replaced by `/api/hosts`; it never returns projects/sessions.
- Browser envelopes expose only `{type,id,hostId,channelId,ciphertext}` to Relay.
- Host envelopes expose only routing IDs, short channel grant and ciphertext.
- Relay grants bind accountId, deviceId, clientInstanceId, hostId, channelId, expiry and purpose `channel`.

- [x] **Step 1: Write failing Relay minimization tests**

Assert a Relay restart while Host is offline returns hosts only and no projects/sessions, schema has no `host_projections`, state/event frames containing plaintext are rejected rather than saved, and Relay database/log test sinks contain none of supplied sentinel project/session/output strings.

- [x] **Step 2: Run minimization tests and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='relay stores no session projection|opaque relay'`

Expected: FAIL because current Relay stores sanitized project/session projections and parses host state/output.

- [x] **Step 3: Remove projection persistence and plaintext routing**

Drop projection methods/table from SQLite/PostgreSQL schemas and migration cleanup. Change `/api/state` to host-only data. Relay routes sealed request/result/event frames using outer host/client/channel IDs, enforces ownership, byte limits, origin, login revocation and pending limits, but never decodes inner method/params/result/event.

- [x] **Step 4: Make Connector loss explicit**

Connector continues to use bounded forwarding and no content queue. On either link loss it closes the paired link so Host can expire the channel; it never silently drops a frame while keeping the channel apparently live.

- [x] **Step 5: Run Relay suites**

Run: `cd backend && npm test -- --test-name-pattern='relay|projection|store' && npm run typecheck`

Expected: PASS, with the old projection behavior replaced by a no-content assertion.

- [x] **Step 6: Commit**

```bash
git add backend/src/relay/store.ts backend/src/relay/schema.postgres.sql backend/src/relay/app.ts backend/src/connector/main.ts backend/test/relay-store.test.ts backend/test/relay-projection.test.ts backend/test/relay.test.ts
git commit -m "feat(relay): forward opaque host channels without session storage"
```

### Task 6: Add browser-to-Host end-to-end encrypted channels

**Files:**
- Create: `backend/src/host/channel.ts`
- Create: `frontend/src/secureChannel.ts`
- Modify: `backend/src/host/server.ts`
- Modify: `backend/src/host/manager.ts`
- Modify: `backend/src/connector/pair.ts`
- Modify: `backend/src/host/config.ts`
- Modify: `frontend/src/api.ts`
- Test: `backend/test/channel.test.ts`
- Test: `frontend/test/secureChannel.test.ts`

**Interfaces:**
- Host channel handshake: signed long-term Host identity plus ephemeral ECDH key and Relay-issued short channel grant.
- `SecureChannel.seal(request)` / `SecureChannel.open(response)` use monotonically checked per-direction nonces internal to one channel; nonce counters are transport state, not session offsets.
- `RpcClient.openHost(host)` pins the Host fingerprint and returns a fresh channelId.
- `RpcClient.request` adds one operationId inside the sealed request and never automatically replays it.

- [x] **Step 1: Write failing cryptographic channel tests**

Use real Node/Web Crypto-compatible vectors. Prove browser and Host derive the same key, Relay-visible envelopes contain no sentinel plaintext, tampering/wrong channel/replayed nonce fails, a changed pinned fingerprint blocks connection, and a fresh reconnect channel cannot decrypt or authorize old frames.

- [x] **Step 2: Run channel tests and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='end-to-end channel'`

Run: `cd frontend && npm run test:unit -- --test-name-pattern='secure channel'`

Expected: FAIL because secure channel modules do not exist.

- [x] **Step 3: Implement versioned authenticated handshake and envelopes**

Use a maintained platform primitive set: P-256 ECDH for ephemeral agreement, HKDF-SHA256 for directional keys, AES-256-GCM for frames, and an Ed25519 Host identity signature over transcript version/host/channel/ephemeral keys. Store the encrypted Host identity private key locally under the Keychain-derived wrapping key; publish only the public key/fingerprint through pairing metadata.

Persist only Host fingerprints in browser localStorage, never terminal/session content. First use is explicit TOFU; a changed fingerprint raises `HOST_IDENTITY_CHANGED`. Keep an optional displayed fingerprint for out-of-band verification.

- [x] **Step 4: Integrate sealed RPC and event delivery**

Relay sends a 30-second renewable channel grant; Host validates account/device/client/host/channel/audience before handshake and renewals. Decrypt only inside Host, encrypt each targeted result/event separately, and close the channel on nonce gap/replay/authentication failure. Browser rejects unsealed content frames.

- [x] **Step 5: Run crypto, auth and type suites**

Run: `cd backend && npm test -- --test-name-pattern='channel|authorization|relay' && npm run typecheck`

Run: `cd frontend && npm run test:unit -- --test-name-pattern='secure channel|RPC' && npm run typecheck`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add backend/src/host/channel.ts backend/src/host/server.ts backend/src/host/manager.ts backend/src/connector/pair.ts backend/src/host/config.ts backend/test/channel.test.ts frontend/src/secureChannel.ts frontend/src/api.ts frontend/test/secureChannel.test.ts frontend/test/api.test.ts
git commit -m "feat(security): encrypt browser host channels end to end"
```

### Task 7: Move React terminal state and controls to offsets

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/TerminalView.tsx`
- Modify: `frontend/src/components/Workspace.tsx`
- Modify: `frontend/src/components/SessionDetails.tsx`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/styles.css`
- Test: `frontend/test/workspace.spec.ts`
- Test: `frontend/test/protocol.test.ts`

**Interfaces:**
- App loads `/api/hosts`, then asks each online encrypted Host for `list`; offline hosts contribute no project/session data.
- Terminal attach sends `lastAppliedOffset`; journal events feed one `OffsetCursor`.
- Input/resize/interrupt/terminate carry `runtimeOffset`, `controlOffset`, and operationId supplied by `RpcClient`.
- UI displays `journalState`, indeterminate operation warnings, TOFU/fingerprint state, and readonly reconnect state.

- [x] **Step 1: Update Playwright fixtures and write failing interaction tests**

Model sealed Host calls at the browser API boundary or use the real stack for cryptographic tests. Assert initial attach is readonly, explicit claim then resize enables direct xterm input, input contains no inputSeq, takeover revokes old controlOffset, reconnect opens a new channel and remains readonly, offset gap triggers reattach, offline Host shows no cached sessions, and journal failure disables history/control with a visible explanation.

- [x] **Step 2: Run focused Playwright tests and verify RED**

Run: `cd frontend && npm run test:e2e -- --grep='offset|readonly|journal|offline host'`

Expected: FAIL against the legacy epoch/sequence client.

- [x] **Step 3: Implement Host-sourced state loading and offset terminal rendering**

Remove the old offline-state merge from `App.refresh`. Reset terminal state on runtimeOffset/channel changes, install snapshot at baseOffset, buffer newer journal events, ACK appliedOffset after xterm finishes writing, and reattach on any gap. Non-output events advance the cursor and update the session projection without writing terminal bytes.

- [x] **Step 4: Implement explicit ownership and failure UI**

Compare controller to the active channel identity, not the persistent client/device identity. Disable stdin on reconnect, storage failure, stale control, snapshot load and pending resize. Surface `OPERATION_INDETERMINATE` without retry controls, and show Host identity/fingerprint state in settings.

- [x] **Step 5: Run frontend unit, Playwright, typecheck and build**

Run: `cd frontend && npm run test:unit && npm run test:e2e && npm run typecheck && npm run build`

Expected: PASS, with no console/page errors.

- [x] **Step 6: Commit**

```bash
git add frontend/src/App.tsx frontend/src/TerminalView.tsx frontend/src/components/Workspace.tsx frontend/src/components/SessionDetails.tsx frontend/src/types.ts frontend/src/styles.css frontend/test/workspace.spec.ts frontend/test/protocol.test.ts
git commit -m "feat(frontend): synchronize terminal sessions by host offsets"
```

### Task 8: Prove crash recovery, privacy and multi-browser end-to-end behavior

**Files:**
- Modify: `backend/test/fixtures/setup.ts`
- Modify: `backend/test/integration.test.ts`
- Create: `backend/test/fault-integration.test.ts`
- Create: `backend/test/privacy-integration.test.ts`
- Modify: `frontend/test/live-browser-check.mjs`
- Modify: `backend/README.md`
- Modify: `frontend/README.md`

**Interfaces:**
- Real fixture exposes controlled Host/Connector/Relay restart, journal fault injection, Relay database inspection and two encrypted browser clients.
- Logical terminal digest helper compares rows, cells, attributes, cursor and modes at a specified appliedOffset.

- [x] **Step 1: Write failing real-stack fault tests**

Cover two encrypted clients viewing one real PTY, explicit takeover, stale queued input rejection, connector/Relay restart, Host `SIGKILL` recovery, request/result commit crash points, disk-full simulation, snapshot corruption fallback, and no automatic replay of unknown input.

- [x] **Step 2: Run real-stack tests and verify RED**

Run: `cd backend && npm test -- --test-name-pattern='real encrypted relay|fault boundary|privacy boundary'`

Expected: FAIL until fixture and full integration paths support the new protocol.

- [x] **Step 3: Complete fixture and recovery wiring**

Make every restart use the same local database/key, create a fresh browser channel after reconnect, and expose journal events for assertions without bypassing production encryption or operation validation. Compare Host history and both browser event streams by literal offsets/digests.

- [x] **Step 4: Add Relay privacy inspection**

Send unique sentinel values for project path, session title, prompt and output. Inspect Relay SQLite/PostgreSQL-facing rows, captured logs and raw routed frames; assert no sentinel appears while Host history decrypts and renders all expected content.

- [x] **Step 5: Document operational behavior**

Update setup, migration, Keychain, TOFU fingerprint, permanent history, disk warning, `journal_unavailable`, indeterminate operations and recovery instructions. Clearly state the PTY/SQLite atomicity and first-use MITM limitations.

- [x] **Step 6: Run all backend verification**

Run: `cd backend && npm test && npm run typecheck && npm run build`

Expected: all tests pass; only explicitly environment-gated PostgreSQL/native smoke tests may skip with their documented reason.

- [x] **Step 7: Commit**

```bash
git add backend/test/fixtures/setup.ts backend/test/integration.test.ts backend/test/fault-integration.test.ts backend/test/privacy-integration.test.ts backend/README.md frontend/README.md frontend/test/live-browser-check.mjs
git commit -m "test: verify durable encrypted remote sessions end to end"
```

### Task 9: Final live verification and direct `main` delivery

**Files:**
- Modify only if a regression test first reproduces a discovered defect.

**Interfaces:**
- No new interfaces; this is the delivery gate.

- [x] **Step 1: Run the complete automated matrix from a clean process state**

Run: `cd backend && npm test && npm run typecheck && npm run build`

Run: `cd frontend && npm run test:unit && npm run typecheck && npm run build && npm run test:e2e`

Expected: zero failures, zero cancelled tests and no unexpected skips.

- [x] **Step 2: Run the real development stack and browser smoke**

Start backend/Connector/Relay and frontend using their documented commands. Exercise login, project list, session selection, readonly attach, claim, direct xterm input, output, second-browser takeover, old-browser rejection, history, resize, reconnect and storage-failure UI. Capture console/page errors and require an empty list.

- [x] **Step 3: Audit requirements and sensitive persistence**

Inspect the final diff and map every specification section to code/tests. Search Relay code/schema for removed projection/content fields and scan a test Relay database for sentinels. Search Host control paths for direct `pty.write`, `pty.resize`, signal or broadcast calls outside the recorded pipeline and justify the terminal protocol-response exception.

- [x] **Step 4: Run final repository checks**

Run: `git diff --check && git status --short && git log --oneline --decorate -12`

Expected: no whitespace errors and only intentional tracked changes/commits.

- [x] **Step 5: Use the finishing workflow and push `main`**

Because the user already selected direct `main`, do not present a merge choice or create another branch. After fresh verification, push exactly the verified `main` HEAD:

```bash
git push origin main
```

Confirm the remote branch points to the verified commit before reporting delivery.
