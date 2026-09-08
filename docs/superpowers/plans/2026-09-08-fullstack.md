# 多面体 V1 Implementation Plan

> For agentic workers: use subagent-driven-development; implementation contracts live in docs/implementation/CONTRACT.md.

**Goal:** Implement the approved terminal workbench with independent frontend and backend packages, real native CLI PTYs, host persistence, authenticated relay and cross-browser control.
**Architecture:** React/Vite frontend communicates only with relay HTTP/WebSocket APIs. A separate local Session Host owns processes and terminal state; a disposable connector relays authorized requests outbound. SQLite is local; production relay uses PostgreSQL and OIDC.
**Tech Stack:** TypeScript, React, Vite, Fastify, ws, node-pty, xterm 5.5, SQLite, PostgreSQL, jose, openid-client.
**Spec:** docs/superpowers/specs/2026-09-08-agent-workbench-v1-design.md; latest DESIGN.md supersedes visual sections.

## Global Constraints
- frontend/ and backend/ are independent folders and packages; demo is preserved.
- No CLI permission bypass; product auth independent of native vendor login.
- Browser closure/relay restart cannot kill hosted processes. Only managed sessions are controllable.
- No automatic input replay; runtime/control epochs enforced at the host.
- Realpath directory containment, ownership validation and <=30 second grant expiry.
- Existing workspace has no git; do not initialize or create commits.

## Deliverables and verification
- [x] Host runtime: create shared types/wire, path validation, SQLite records/output, serial PTY/headless runtime and RPC auth. Test directory escapes, stale control/runtime, duplicate input, snapshot plus output, invalid grants, retention and restart records before implementing each boundary. Run `cd backend && npm test` with real PTY fixtures.
- [x] Relay/account service: implement independent Fastify app, OIDC/loopback dev auth, CSRF/Origin checks, PostgreSQL and dev SQLite store, expiring single-use host pairing, owner-only HTTP/WS proxy, renewal/revocation and slow reader bounds. Real Fastify/WS tests must reject foreign-account and revoked clients.
- [x] CLI adapters/install tooling: detect actual local binaries, validate versions, safe session-scoped hooks, explicit native session resume, macOS launch scripts and Keychain. Tests validate exact argv, no --last or bypass, Hook sanitation and child isolation. Real version diagnostics and trust-screen PTY smoke checks (no model prompt sent).
- [x] Frontend: port approved palette/layout to React, scoped project/session creation, login/settings/pairing, real xterm attach/control/input/resize/reconnect, archive/history/rename/resume. Build independently; Playwright verifies two browser tabs, projects persisted on reload, readonly takeover and auth failures.
- [x] Integration and delivery: run backend checks, frontend build, real PTY regression through relay, both CLI launch smoke, layout screenshots, document commands/env/deployment and unverified external acceptance items. Supply production OIDC/PG/reverse proxy and macOS packaging commands; do not claim signing, cloud deployment or two physical PC acceptance without credentials/hardware.

Progress and findings: docs/implementation/PROGRESS.md.

Completed implementation and local verification: 2026-09-09. External deployment, signing and hardware acceptance are explicitly pending in docs/implementation/VERIFICATION.md.
