"use strict";
// MySQL 8.0.19+ / MariaDB 10.6+ DDL, one statement per entry. No schema or database is named or created here:
// ms-sql (MS_SQL_SCHEMA) creates the database and every connection is bound to it. Idempotent like the PostgreSQL one.
// Rules (docs/architecture-plan-ms-sql.md 3.3): utf8mb4_bin on every hash/identifier/kind/role/allowlist column so
// comparisons are case-sensitive like PostgreSQL; indexes live inside CREATE TABLE (no CREATE INDEX IF NOT EXISTS);
// no literal DEFAULT on JSON (callers always pass the value); the partial unique index becomes a STORED generated
// column (NULL for non-unique kinds) plus a UNIQUE key with the same name.
const BIN = "CHARACTER SET utf8mb4 COLLATE utf8mb4_bin";
const TS = "DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)";
const TABLE = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
module.exports = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ms_users (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,
 allowlist VARCHAR(16) ${BIN} NOT NULL DEFAULT 'pending',
 metadata JSON NOT NULL,created_at ${TS},last_seen_at ${TS},
 CONSTRAINT ms_users_allowlist_check CHECK (allowlist IN ('pending','approved','denied'))
) ${TABLE}`,
  `CREATE TABLE IF NOT EXISTS ms_user_credentials (
 token_hash VARCHAR(64) ${BIN} NOT NULL PRIMARY KEY,user_id BIGINT NOT NULL,created_at ${TS},revoked_at DATETIME(3) NULL,
 CONSTRAINT ms_user_credentials_user_fk FOREIGN KEY (user_id) REFERENCES ms_users(id)
) ${TABLE}`,
  // Roles belong to characters (ms_characters lives in ms-character, so no foreign key here). "player" is implicit.
  `CREATE TABLE IF NOT EXISTS ms_character_roles (
 character_id BIGINT NOT NULL,role VARCHAR(32) ${BIN} NOT NULL,PRIMARY KEY(character_id,role)
) ${TABLE}`,
  `CREATE TABLE IF NOT EXISTS ms_sessions (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,server_key VARCHAR(64) ${BIN} NOT NULL,player_id INT NOT NULL,user_id BIGINT NULL,
 started_at ${TS},ended_at DATETIME(3) NULL,end_reason TEXT NULL,
 KEY ms_sessions_user (user_id,started_at),
 CONSTRAINT ms_sessions_user_fk FOREIGN KEY (user_id) REFERENCES ms_users(id)
) ${TABLE}`,
  `CREATE TABLE IF NOT EXISTS ms_connection_identifiers (
 user_id BIGINT NOT NULL,kind VARCHAR(32) ${BIN} NOT NULL,value VARCHAR(256) ${BIN} NOT NULL,
 first_seen_at ${TS},last_seen_at ${TS},
 owner_key VARCHAR(300) ${BIN} GENERATED ALWAYS AS (IF(kind IN ('accountId','steamId','epicId','discordId','hardwareId'),CONCAT(kind,':',value),NULL)) STORED,
 PRIMARY KEY(user_id,kind,value),
 UNIQUE KEY ms_connection_identifiers_unique_owner (owner_key),
 CONSTRAINT ms_connection_identifiers_user_fk FOREIGN KEY (user_id) REFERENCES ms_users(id)
) ${TABLE}`,
  `CREATE TABLE IF NOT EXISTS ms_bans (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id BIGINT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,
 created_at ${TS},expires_at DATETIME(3) NULL,revoked_at DATETIME(3) NULL,
 KEY ms_bans_user (user_id,revoked_at,expires_at),
 CONSTRAINT ms_bans_user_fk FOREIGN KEY (user_id) REFERENCES ms_users(id)
) ${TABLE}`,
  `CREATE TABLE IF NOT EXISTS ms_audit_log (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,user_id BIGINT NULL,
 details JSON NOT NULL,created_at ${TS},
 CONSTRAINT ms_audit_log_user_fk FOREIGN KEY (user_id) REFERENCES ms_users(id)
) ${TABLE}`,
]);
