"use strict";
// PostgreSQL DDL, one statement per entry (ms-sql runs a single statement per call).
// No schema is named or created here: ms-sql (MS_SQL_SCHEMA) creates it and sets the search_path of every connection.
// Idempotent: creates missing objects and leaves existing tables and data untouched.
module.exports = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ms_users (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 allowlist TEXT NOT NULL DEFAULT 'pending' CHECK(allowlist IN ('pending','approved','denied')),
 metadata JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS ms_user_credentials (
 token_hash TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES ms_users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),revoked_at TIMESTAMPTZ
)`,
  // Roles belong to characters (ms_characters lives in ms-character, so no foreign key here). "player" is implicit.
  "CREATE TABLE IF NOT EXISTS ms_character_roles (character_id BIGINT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(character_id,role))",
  `CREATE TABLE IF NOT EXISTS ms_sessions (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,server_key TEXT NOT NULL,player_id INTEGER NOT NULL,user_id BIGINT REFERENCES ms_users(id),
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),ended_at TIMESTAMPTZ,end_reason TEXT
)`,
  "CREATE INDEX IF NOT EXISTS ms_sessions_user ON ms_sessions(user_id,started_at)",
  `CREATE TABLE IF NOT EXISTS ms_connection_identifiers (
 user_id BIGINT NOT NULL REFERENCES ms_users(id),kind TEXT NOT NULL,value TEXT NOT NULL,
 first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,kind,value)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ms_connection_identifiers_unique_owner ON ms_connection_identifiers(kind,value)
 WHERE kind IN ('accountId','steamId','epicId','discordId','hardwareId')`,
  `CREATE TABLE IF NOT EXISTS ms_bans (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES ms_users(id),reason TEXT NOT NULL,actor TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ,revoked_at TIMESTAMPTZ
)`,
  "CREATE INDEX IF NOT EXISTS ms_bans_user ON ms_bans(user_id,revoked_at,expires_at)",
  `CREATE TABLE IF NOT EXISTS ms_audit_log (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,user_id BIGINT REFERENCES ms_users(id),
 details JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
]);
