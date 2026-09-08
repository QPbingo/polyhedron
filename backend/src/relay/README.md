# Account and WebSocket relay

`createRelay(config)` in `app.ts` builds a Fastify application without opening a listener. Call `app.listen({host, port})`; `app.close()` closes remote channels and its database. The application exposes `app.relayStore` for explicit local provisioning. `main.ts` is the environment-driven entry point.

The relay never launches agents and never stores project paths, terminal output, prompts, history, or snapshots. Request logging is disabled. SQLite/PostgreSQL persist account identity, hashed browser session IDs, hashed pairing credentials, encrypted host credentials and OIDC flow state, metadata-only login/pairing/revocation audit events, and minimal offline project/session summaries. The `host_projections` table contains allowlisted IDs, display names/titles, agent, process/activity state, runtime/control epochs, dimensions, archive state and timestamps. It excludes project paths, native session IDs, controllers, warnings, prompts, hooks and terminal contents. Host signing keys and PKCE state use AES-256-GCM with a key derived from `RELAY_SESSION_SECRET`. Keep that secret stable and back it up separately from the database.

## Configuration

| Environment | Meaning |
| --- | --- |
| `DEV_AUTH=1` | Explicit development login; non-production environment and loopback bind/origin required. No fallback from failed OIDC. |
| `BIND_HOST` / `HOST` | Listener, default `127.0.0.1`. |
| `PORT` | Listener port, default `3001`. |
| `PUBLIC_ORIGIN` | Exact browser origin, default `http://127.0.0.1:18417`; production requires HTTPS. |
| `RELAY_SESSION_SECRET` | Required secret, at least 32 characters. Generate using cryptographic randomness. |
| `RELAY_DB_PATH` | Development SQLite file, default `.data/relay.sqlite`. Programmatic tests use `databasePath: ':memory:'`. |
| `DATABASE_URL` | Required PostgreSQL connection in production. Configure TLS through the PostgreSQL connection settings. |
| `OIDC_ISSUER` | OIDC provider issuer URL. Discovery and token endpoints require TLS. |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | Registered OIDC client; callback is `PUBLIC_ORIGIN/auth/callback`. |
| `DEV_HOST_CONFIG` | Optional explicit local host configuration JSON path. Accepted only with loopback development auth; account must be `dev-local`. |

Production configuration fails closed when OIDC, PostgreSQL, HTTPS origin or the session secret is missing. Deploy behind a same-origin HTTPS reverse proxy that serves the frontend, preserves the browser Origin and proxies WebSocket upgrades. The relay does not serve frontend assets. Apply the frontend CSP at the static serving layer. Do not expose the development service through a public reverse proxy.

`schema.postgres.sql` describes the PostgreSQL schema also initialized by the store. This version runs one relay process per region; its live WebSocket registry is process-local. Multiple replicas require coordinated routing and revocation notifications before being enabled.

## Authentication and routing

OIDC uses server-side, expiring, one-use state/nonce/PKCE flows. `openid-client` performs discovery, claims validation, code exchange and explicit JWKS signature verification. Browser cookies are HttpOnly, SameSite=Lax and Secure with the `__Host-` prefix in production. Mutation endpoints require the session-derived CSRF token and exact Origin. Browser WebSockets require both cookie authentication and exact Origin.

A host pairs through an expiring, rate-limited code. Approval binds it to the authenticated account. The poll credential retrieves the host secret once, using an atomic update. Browser RPCs recheck the persisted account-to-host relationship. Host WebSockets use their independent bearer credential and reject browser Origin headers. Host-provided account claims never select an owner.

Each host RPC carries an HS256 grant signed using the host token, with account, host, client, method, optional session/runtime scope, and at most 30 seconds of validity. Attached clients renew every 10 seconds. Logout invalidates the durable browser session, detaches its clients and closes their sockets. `GET /api/browsers` lists only the account’s unexpired, unrevoked logins as `{id, createdAt, expiresAt, current}`; the ID is a hash and cannot authenticate as a cookie. `POST /api/browsers/:id/revoke` requires Origin and CSRF checks, atomically verifies ownership and revokes the login, then detaches every connected tab for that login. Revoking the current login also clears its cookie. Host revocation removes its binding, sends detach before closing its connector and prevents the old token from reconnecting. Neither operation terminates a managed agent.

Successful host list responses replace the offline projection; state events merge safe project/session summaries in host wire order. Host disconnects and relay restarts retain those summaries for the owning account; offline project paths are returned as empty strings and native IDs/controllers as null. Live paths remain transient. Revoking a host deletes its projection. Each host projection has an 8 MiB serialized metadata limit.

Output, snapshot and resync events reach only the subscribed tab in the host's owning account. Relay request queues are limited to 64 outstanding requests and 2 MiB of inbound queued data per browser. Terminal output backlog is limited to 2 MiB; responses and screen snapshots have a separate 8 MiB budget to support large true-color screens. Oversized/slow sockets close and require a new snapshot.

## Verification

Run from `backend/`:

```sh
node --import tsx --test test/relay*.test.ts
npm run typecheck
```

The tests exercise real Fastify HTTP/WebSocket transports, SQLite persistence, account isolation, one-use pairing, Origin/CSRF validation, signed grants, ten-second renewal, durable revocation, targeted binary output, large snapshots, detach ordering bounded stalled-host queues, remote browser-login revocation, and sanitized offline projections surviving host disconnect and relay restart. The OIDC test simulates only the identity provider's HTTP responses and uses the actual SDK, PKCE exchange and generated RSA/JWKS signatures. A real PostgreSQL 17 container was exercised through `TEST_DATABASE_URL` in the full backend suite (40 passed, zero skipped). Real identity-provider tenant login and production TLS deployment still need environment-specific validation.
