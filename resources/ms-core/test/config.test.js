"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../server/config");

function envFile(t, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ms-core-env-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ms-core-env-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, ".env"); fs.writeFileSync(file, content); return file;
}

test("resource env files support BOM, quoted values and comments", t => {
  const file = envFile(t, '\uFEFF# fixture\nMS_ALLOWLIST_FORM_URL="https://forms.example/a%23b"\nMS_ACCESS_POLL_SECONDS=7 # comment\n');
  const config = loadConfig({}, { envFile: file });
  assert.equal(config.formUrl, "https://forms.example/a%23b");
  assert.equal(config.accessPollMs, 7000);
});
test("host environment overrides the file without mutating the host object", t => {
  const file = envFile(t, "MS_SERVER_KEY=FromFile\nMS_ACCESS_POLL_SECONDS=7\n");
  const env = { MS_SERVER_KEY: "FromHost", MS_ACCESS_POLL_SECONDS: "2" };
  const config = loadConfig(env, { envFile: file });
  assert.equal(config.serverKey, "FromHost");
  assert.equal(config.accessPollMs, 2000);
  assert.deepEqual(Object.keys(env).sort(), ["MS_ACCESS_POLL_SECONDS", "MS_SERVER_KEY"]);
});
test("an explicit empty host variable is not silently replaced", t => {
  const file = envFile(t, "MS_SERVER_KEY=FromFile\n");
  assert.equal(loadConfig({ MS_SERVER_KEY: "" }, { envFile: file }).serverKey, "MagicSchoolRP");
});
test("a missing env file falls back to the supplied environment", t => {
  const file = envFile(t, ""); fs.unlinkSync(file);
  assert.equal(loadConfig({ MS_SERVER_KEY: "FromHost" }, { envFile: file }).serverKey, "FromHost");
  assert.equal(loadConfig({}, { envFile: file }).serverKey, "MagicSchoolRP");
});
test("explicit test environments do not import the operator's real env file", () => {
  assert.equal(loadConfig({}).serverKey, "MagicSchoolRP");
});
test("required identifiers are parsed, deduplicated and validated", () => {
  assert.deepEqual(loadConfig({}).requiredIdentifiers, []);
  assert.deepEqual(loadConfig({ MS_REQUIRED_IDENTIFIERS: " discordId, steamId,discordId " }).requiredIdentifiers, [["discordId"], ["steamId"]]);
  assert.deepEqual(loadConfig({ MS_REQUIRED_IDENTIFIERS: "discordId,steamId | epicId,epicId|steamId" }).requiredIdentifiers, [["discordId"], ["steamId", "epicId"]]);
  assert.deepEqual(loadConfig({}).lockedMenuPages, ["inventory", "gear", "talents", "quests", "map", "mail", "collections", "challenges"]);
  assert.deepEqual(loadConfig({ MS_LOCKED_MENU_PAGES: " map, mail,map " }).lockedMenuPages, ["map", "mail"]);
  assert.deepEqual(loadConfig({ MS_LOCKED_MENU_PAGES: "" }).lockedMenuPages, []);
  assert.throws(() => loadConfig({ MS_LOCKED_MENU_PAGES: "map,nope" }), /MS_LOCKED_MENU_PAGES/);
  assert.throws(() => loadConfig({ MS_REQUIRED_IDENTIFIERS: "steamId||epicId" }), /MS_REQUIRED_IDENTIFIERS/);
  assert.throws(() => loadConfig({ MS_REQUIRED_IDENTIFIERS: "discordName" }), /MS_REQUIRED_IDENTIFIERS/);
  assert.throws(() => loadConfig({ MS_REQUIRED_IDENTIFIERS: "ip" }), /MS_REQUIRED_IDENTIFIERS/);
});
