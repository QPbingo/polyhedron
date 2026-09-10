# Account and WebSocket relay

`createRelay(config)` in `app.ts` builds a Fastify application without opening a listener. Call `app.listen({host, port})`; `app.close()` closes remote channels and its database. The application exposes `app.relayStore` for explicit local provisioning. `main.ts` is the environment-driven entry point.

The relay never launches agents and never stores project paths, projects, sessions, Agent state, terminal output, prompts, history, snapshots, native session IDs or controller state. Request logging is disabled. SQLite/PostgreSQL persist account identity, hashed browser session IDs, hashed pairing credentials, encrypted host credentials and OIDC flow state, plus metadata-only login/pairing/revocation audit events. There is no host/session projection table. Host credentials and PKCE state use AES-256-GCM with a key derived from `RELAY_SESSION_SECRET`. Keep that secret stable and back it up separately from the database.

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

Opening a Host channel carries an HS256 grant signed with the Host credential and bound to the account subject, Host, tab client ID, one-use channel ID, client ephemeral public key, `purpose=channel` and at most 30 seconds of validity. Active channels renew every 10 seconds. RPC methods, parameters, results and events remain inside AES-256-GCM ciphertext and are never parsed by Relay. Logout invalidates the durable browser session, closes its channels and sockets, and does not terminate a managed Agent. Browser-login and Host revocation require account ownership, Origin and CSRF validation.

This protects session content from Relay persistence and passive inspection, but Relay remains the authorization trust boundary. Because Relay stores the Host grant credential and same-account devices require no Host-local approval, an actively compromised Relay can mint a grant for its own ephemeral client key, open a separate encrypted channel, and issue operations. Preventing that requires a Host-registered account/device signing root or explicit local device approval, neither of which is part of this version.

`GET /api/hosts` returns owned Host bindings with current online status. The compatibility `/api/state` endpoint also returns only those Hosts and empty project/session arrays. After a Host disconnect or Relay restart, clients retain no Relay-sourced session view and must reconnect to the Host for an authoritative list and snapshot.

Output, snapshot and resync events reach only the subscribed tab in the host's owning account. Relay request queues are limited to 64 outstanding requests and 2 MiB of inbound queued data per browser. Terminal output backlog is limited to 2 MiB; responses and screen snapshots have a separate 8 MiB budget to support large true-color screens. Oversized/slow sockets close and require a new snapshot.

## Verification

Run from `backend/`:

```sh
node --import tsx --test test/relay*.test.ts
npm run typecheck
```

The tests exercise real Fastify HTTP/WebSocket transports, SQLite persistence, account isolation, one-use pairing, Origin/CSRF validation, short channel grants, renewal, durable revocation, opaque routing, bounded stalled-host queues and remote browser-login revocation. Privacy integration scans routed frames and Relay database/WAL files for unique project, session, prompt and output sentinels while confirming that the encrypted Host can still return them. The OIDC test uses the real SDK with isolated PKCE/state/nonce and RSA/JWKS fixtures. PostgreSQL is explicitly environment-gated through `TEST_DATABASE_URL`; a real identity-provider tenant and production TLS deployment still require environment-specific validation.
