"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGameAdapter } = require("../server/game");
const { loadConfig } = require("../server/config");

function nativePlayer() {
  const calls = [];
  const player = {
    id: 1, connected: true,
    isVisible: () => true, isInvulnerable: () => false, getFastTravelEnabled: () => true,
    setVirtualWorld(value) { calls.push(["world", value]); }, setVisible() {}, setInvulnerable() {}, setFastTravelEnabled() {},
    hold: () => true, release() {},
  };
  return { player, calls };
}

test("the adapter only quarantines and releases; character restore lives elsewhere", () => {
  const game = createGameAdapter(loadConfig({}));
  assert.deepEqual(Object.keys(game).sort(), ["cancel", "kick", "release", "restrict", "send", "setCollision", "setVisible"]);
});

test("effects: visibility is native, collision is sent to the player's client", () => {
  const game = createGameAdapter(loadConfig({})), shown = [], emitted = [];
  const player = { setVisible: v => shown.push(v), emit: (name, payload) => emitted.push([name, payload]) };
  game.setVisible(player, false, { previous: { visible: true } });
  game.setVisible(player, true, { previous: { visible: true } });
  assert.deepEqual(shown, [false, true]);
  game.setCollision(player, false);
  assert.deepEqual(emitted, [["ms-core:collision", JSON.stringify({ enabled: false })]]);
});

test("authentication uses a fixed hold compatible with the native anchor contract", () => {
  const game = createGameAdapter(loadConfig({})), { player, calls } = nativePlayer();
  let anchor;
  player.hold = options => { anchor = options; return !options.rigid || Number.isInteger(options.anchorId); };
  game.restrict(player, { world: 3000000001 });
  assert.equal(anchor.mode, "clamp");
  assert.equal(anchor.owner, "ms-core:authentication");
  assert.equal(anchor.rigid, undefined);
  assert.ok(calls.some(call => Array.isArray(call) && call[0] === "world" && call[1] === 3000000001));
});
