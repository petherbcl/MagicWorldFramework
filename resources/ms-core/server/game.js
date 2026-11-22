"use strict";

const { check } = require("./validation");
const HOLD = "ms-core:authentication";

// Native quarantine while a session is not ready: private world, invisible, held at the spawn.
// Character restore (inventory, look, location) belongs to the character resource.
function createGameAdapter(config) {
  return {
    restrict(player, session) {
      if (!session.previous) session.previous = {
        visible: player.isVisible(), invulnerable: player.isInvulnerable(),
        fastTravel: player.getFastTravelEnabled(),
      };
      player.setVirtualWorld(session.world);
      player.setVisible(false);
      player.setInvulnerable(true);
      player.setFastTravelEnabled(false);
      const position = config.spawn.position;
      // Fixed anchors must not use rigid: that option requires an anchorId.
      check(player.hold({ owner: HOLD, ...position, mode: "clamp", radius: 0, radiusZ: 0, ttlMs: 0 }), "HOLD_FAILED");
    },
    // Effects requested by other resources through Core.Players. Visibility is server side; world collision exists only on
    // the client, so the player's own client applies it (without collision the player must not fall, hence gravity too).
    setVisible(player, visible, session) { player.setVisible(visible ? (session?.previous?.visible ?? true) : false); },
    setCollision(player, enabled) { player.emit("ms-core:collision", JSON.stringify({ enabled })); },
    send(player, eventName, payload) { player.emit(eventName, JSON.stringify(payload)); },
    kick(player, reason) { player.kick(reason); },
    release(player, session) {
      player.release(HOLD);
      player.setVirtualWorld(0);
      player.setVisible(session.previous.visible);
      player.setInvulnerable(session.previous.invulnerable);
      player.setFastTravelEnabled(session.previous.fastTravel);
    },
    cancel(session) { session.player.release(HOLD); },
  };
}

module.exports = { createGameAdapter };
