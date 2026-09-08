# SDD ledger — plan: docs/superpowers/plans/2026-09-08-fullstack.md
Ruling: Current user explicitly approved existing design/requirements and requests implementation. Proceed without repeating design approval gates.
Ruling: Preserve demos/; production code starts with actual empty host state and explicit project registration, never fake native sessions.
Ruling: Unavailable OIDC/domain/signing credentials do not block local implementation; production configuration stays explicit and mandatory.
Ruling: Separate frontend and backend packages; runtime and relay are independent backend processes. No git repository initialization.
Completed: host runtime (root), frontend, relay, adapters/install; integration and local delivery verified on 2026-09-09.

## Implementation and review
- Separate frontend/backend packages and lockfiles; static demos preserved.
- Real host PTY + parsed snapshots + segmented history + project persistence; independent relay and connector; owner/method/session/runtime grants; single-controller input without replay.
- Production OIDC/PostgreSQL, CSRF/Origin, one-use pairing, Keychain configuration, browser-login revocation, sanitized durable offline summaries.
- Approved frontend ported to React/xterm with project-scoped session lifecycle, settings, history, six palettes and real API/WS.
- Native adapters verified against installed CLI versions; hooks sanitize payloads and preserve trust/permissions; portable Node downloader, LaunchAgent and release tooling supplied.
- Review fixes include split control-sequence checkpoints, C1 parser restart, idempotent old output ACKs, dense snapshot limits, pending request bounds, conservative approval correlation, resume preflight, managed descendant termination, retention markers, atomic startup locking and explicit OIDC signature checks.

## Evidence and delivery
- Full backend suite with PostgreSQL 17: 40 passed, 0 skipped.
- Portable official Node 24.20.0 arm64 host/integration subset: 11 passed.
- Frontend: 5 unit and 9 Chrome tests passed, plus real two-context echo-PTY lifecycle check.
- Both production builds and Docker images passed; Nginx syntax/real headers and Compose configuration passed.
- Native Codex 0.153.4 / Claude 2.1.236 startup smoke reached trust screens without prompts or approvals.
- Unsigned Mac package built and payload checked; no global install/signing/notarization.
- Final preview is http://127.0.0.1:18417/ with backend :3001. Ports 5173/5174 belong to unrelated applications and were preserved. Static demo :4173 remains separate.
- Registered three actual directories (repository/frontend/backend), no live Agent sessions created in the final development app.
- Auto-review initially rejected stopping an old host. Read-only SQLite evidence showed zero sessions; process inspection showed only its esbuild helper. Repeating the request with executable guards was approved, and the empty host was updated successfully.

All test boundaries, screenshots and external acceptance items: [VERIFICATION.md](VERIFICATION.md). Production tenant/TLS deployment, paid model tasks, physical dual-PC/performance acceptance and signed clean-Mac installation remain unverified, not marked as passed.

Follow-up: project folder picker implemented in frontend/src/ProjectForm.tsx and authenticated listDirectories host RPC. Real directory/symlink/account boundaries and live selection verified; 6 backend host/integration checks and 10 Chrome tests pass. Nested Escape propagation fixed with regression coverage. Preview backend refreshed only after guarded confirmation of zero sessions/no Agent children.

Follow-up: consolidated hover/focus project menu, removed path subtitles, and native prompt row shading via read-only xterm buffer/render APIs. 7 unit / 12 Chrome checks and production build passed, including alternate-screen highlight cleanup. UI/menu changes verified against the live app without session creation or input.
