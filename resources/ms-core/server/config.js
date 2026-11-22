"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { UNIQUE_IDENTIFIERS } = require("./validation");

function readEnvFile(filename) {
  if (!filename) return {};
  try { return parseEnv(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("MS_CORE_ENV_FILE_UNREADABLE");
  }
}

function integer(env, key, fallback, min, max) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
function parseRequired(value) {
  const groups = new Map();
  for (const part of String(value || "").split(",")) {
    if (!part.trim()) continue;
    const kinds = [...new Set(part.split("|").map(kind => kind.trim()))];
    for (const kind of kinds) if (!UNIQUE_IDENTIFIERS.includes(kind)) throw new Error("Invalid MS_REQUIRED_IDENTIFIERS: " + (kind || part.trim()));
    const key = [...kinds].sort().join("|");
    if (!groups.has(key)) groups.set(key, Object.freeze(kinds));
  }
  return [...groups.values()];
}
const MENU_PAGES = Object.freeze(["inventory", "gear", "talents", "quests", "map", "mail", "collections", "challenges", "settings"]);
const DEFAULT_LOCKED_MENU_PAGES = "inventory,gear,talents,quests,map,mail,collections,challenges";
// Comma-separated pause menu pages kept shut before the session is ready (empty = none).
function parseMenuPages(value) {
  const pages = [];
  for (const part of String(value).split(",")) {
    const page = part.trim();
    if (!page) continue;
    if (!MENU_PAGES.includes(page)) throw new Error("Invalid MS_LOCKED_MENU_PAGES: " + page);
    if (!pages.includes(page)) pages.push(page);
  }
  return Object.freeze(pages);
}
function loadConfig(env = process.env, options = {}) {
  // Explicit test environments stay isolated unless a file is requested.
  const envFile = options.envFile !== undefined ? options.envFile :
    env === process.env ? path.resolve(__dirname, "../.env") : null;
  // Never mutate process.env or replace values explicitly supplied by the host.
  env = { ...readEnvFile(envFile), ...env };
  const serverKey = env.MS_SERVER_KEY || "MagicSchoolRP";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverKey)) throw new Error("Invalid MS_SERVER_KEY");
  let formUrl = env.MS_ALLOWLIST_FORM_URL || "";
  if (formUrl) {
    const url = new URL(formUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid MS_ALLOWLIST_FORM_URL");
    formUrl = url.href;
  }
  // Comma-separated account identifiers that every connection must announce (e.g. "discordId,steamId").
  // "," means AND, "|" means OR within a group: "discordId,steamId|epicId" = Discord AND (Steam OR Epic).
  // Parsed into groups; each group needs at least one of its identifiers.
  const requiredIdentifiers = Object.freeze(parseRequired(env.MS_REQUIRED_IDENTIFIERS));
  return Object.freeze({
    // No database settings here: the connection belongs to ms-sql (resources/ms-sql/.env).
    serverKey, formUrl, requiredIdentifiers,
    lockedMenuPages: parseMenuPages(env.MS_LOCKED_MENU_PAGES === undefined ? DEFAULT_LOCKED_MENU_PAGES : env.MS_LOCKED_MENU_PAGES),
    approvalTimeoutMs: integer(env, "MS_APPROVAL_TIMEOUT_SECONDS", 1800, 60, 86400) * 1000,
    accessPollMs: integer(env, "MS_ACCESS_POLL_SECONDS", 5, 1, 60) * 1000,
    maxSessions: 128,
    // SEC-03: how long a database outage is tolerated before sessions that are not ready are kicked.
    outageGraceMs: 5 * 60 * 1000,
    // R-02: native handshake semaphore (concurrent jobs, waiting queue, per-job timeout).
    admission: Object.freeze({ concurrency: 3, maxQueue: 256, taskTimeoutMs: 15000 }),
    quarantineWorldBase: 3000000000,
    spawn: { position: { x: 385396, y: -480395.75, z: -77138.5 }, yaw: -126.9 },
    rolePermissions: { player: ["users.metadata.self"],
      moderator: ["users.read", "allowlist.manage", "bans.manage"], admin: ["*"],
      // Roles ms-character gives every character for its house; no permissions of their own, but known to Roles.set and the admin tool.
      gryffindor: [], hufflepuff: [], ravenclaw: [], slytherin: [], unaffiliated: [] },
  });
}
module.exports = { loadConfig };
