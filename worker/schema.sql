-- Match Manager — Phase 2 schema (D1 / SQLite)
-- See docs/phase2-schema-and-api.md. Apply with:
--   npx wrangler d1 execute match-manager --file worker/schema.sql --remote

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','team_admin','coach')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);

CREATE TABLE IF NOT EXISTS member_teams (
  tenant    TEXT NOT NULL,
  member_id TEXT NOT NULL,
  team_id   TEXT NOT NULL,
  PRIMARY KEY (tenant, member_id, team_id)
);

CREATE TABLE IF NOT EXISTS devices (
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_token ON devices (token_hash);

CREATE TABLE IF NOT EXISTS invites (
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role       TEXT NOT NULL,
  team_id    TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_token ON invites (token_hash);

CREATE TABLE IF NOT EXISTS view_links (
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  team_id    TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (tenant, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS view_links_token ON view_links (token_hash);

CREATE TABLE IF NOT EXISTS docs (
  tenant     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('model','match','plan')),
  id         TEXT NOT NULL,
  body       TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, kind, id)
);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant     TEXT NOT NULL,
  id         TEXT NOT NULL,
  match_id   TEXT NOT NULL,
  type       TEXT NOT NULL,
  at_ms      INTEGER NOT NULL,
  clock_ms   INTEGER,
  period     INTEGER,
  payload    TEXT NOT NULL,
  author     TEXT,
  device     TEXT,
  void_of    TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_idem   ON events (tenant, id);
CREATE INDEX IF NOT EXISTS events_cursor ON events (tenant, seq);
CREATE INDEX IF NOT EXISTS events_match  ON events (tenant, match_id, seq);

CREATE TABLE IF NOT EXISTS lease (
  tenant   TEXT NOT NULL,
  match_id TEXT NOT NULL,
  holder   TEXT,
  name     TEXT,
  seen_at  INTEGER,
  PRIMARY KEY (tenant, match_id)
);
