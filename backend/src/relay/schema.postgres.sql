-- This mirrors RelayStore.init(): account, login, Host binding, pairing, OIDC and
-- content-free audit metadata only. It contains no project/session projection.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
  name TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE (issuer, subject)
);
CREATE TABLE IF NOT EXISTS browser_sessions (
  id_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at BIGINT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS browser_account_idx ON browser_sessions(account_id);
CREATE TABLE IF NOT EXISTS host_bindings (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, token_cipher TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS hosts_account_idx ON host_bindings(account_id);
CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, poll_hash TEXT NOT NULL, name TEXT NOT NULL,
  expires_at BIGINT NOT NULL, account_id TEXT REFERENCES accounts(id), host_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', issued INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oidc_flows (
  id_hash TEXT PRIMARY KEY, payload_cipher TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, account_id TEXT, host_id TEXT, event TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events(created_at);

DROP TABLE IF EXISTS host_projections;
