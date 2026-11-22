"use strict";

let view = null, pageReady = false, lastState = null, pendingCredential = null;
// The CEF storage of the first view of a game session can read as empty (even after seconds) while a later view reads
// the stored key. When the page finds no key it asks for a fresh view, a limited number of times per session.
const MAX_VIEW_RETRIES = 2, VIEW_RETRY_DELAY_MS = 800;
let viewAttempt = 0, retrySessionId = null, retryTimer = null;

function flush() {
  if (pageReady && view !== null && lastState) Web.emit(view, "session", { ...lastState, viewAttempt, maxViewRetries: MAX_VIEW_RETRIES });
  if (pageReady && view !== null && pendingCredential) Web.emit(view, "credential", pendingCredential);
}
function closeView() {
  if (view !== null) Web.destroyView(view);
  view = null; pageReady = false;
}
function onStorageEmpty() {
  if (view === null || lastState === null || viewAttempt >= MAX_VIEW_RETRIES || retryTimer !== null) return;
  viewAttempt++;
  closeView();
  retryTimer = setTimeout(() => { retryTimer = null; if (lastState !== null && lastState.status !== "ready") show(lastState); }, VIEW_RETRY_DELAY_MS);
}
// The pause menu stays available with the pages listed by the server (MS_LOCKED_MENU_PAGES) held shut, before and after the
// session is ready (only a resource stop gives them back). The list comes in the session payload; `heldPages` is what this script currently holds, so it gives back
// exactly that (also pages dropped from the list in a later payload).
const heldPages = new Set();
function setLockedPages(pages) {
  const wanted = new Set(Array.isArray(pages) ? pages.filter(page => typeof page === "string") : []);
  for (const page of [...heldPages]) {
    if (wanted.has(page)) continue;
    try { Game.setMenuPageEnabled(page, true); heldPages.delete(page); }
    catch (error) { console.log("[ms-core] menu page '" + page + "' release failed: " + (error && error.message || error)); }
  }
  for (const page of wanted) {
    if (heldPages.has(page)) continue;
    try { Game.setMenuPageEnabled(page, false); heldPages.add(page); }
    catch (error) { console.log("[ms-core] menu page '" + page + "' lock failed: " + (error && error.message || error)); }
  }
}
function show(state) {
  if (state.sessionId !== retrySessionId) { retrySessionId = state.sessionId; viewAttempt = 0; }
  lastState = state;
  if (state.status === "ready") {
    closeView();
    LocalPlayer.restorePlayerInput();
    setLockedPages(state.lockedMenuPages);
    Game.setPauseMenuEnabled(true);
    Game.setActionScreenEnabled(true);
    Game.setToolWheelEnabled(true);
    return;
  }
  LocalPlayer.stopPlayerInput();
  Game.setPauseMenuEnabled(true);
  setLockedPages(state.lockedMenuPages);
  Game.setActionScreenEnabled(false);
  Game.setToolWheelEnabled(false);
  if (view === null) {
    view = Web.createView("fw://resources/ms-core/client/ui/index.html", { focus: true });
    Web.on(view, "ready", () => { pageReady = true; flush(); });
    Web.on(view, "register", payload => Events.emitServer("ms-core:register", payload));
    Web.on(view, "storageEmpty", onStorageEmpty);
    Web.on(view, "credentialStored", payload => {
      pendingCredential = null;
      Events.emitServer("ms-core:credentialStored", payload);
    });
  }
  flush();
}

Events.on("ms-core:session", state => {
  if (!state || typeof state !== "object" || typeof state.status !== "string") return;
  show(state);
});
Events.on("ms-core:credential", payload => {
  if (!payload || typeof payload.sessionId !== "string" || typeof payload.credential !== "string") return;
  pendingCredential = payload; flush();
});
Events.on("ms-core:notice", value => {
  if (!value || typeof value.text !== "string") return;
  Game.notify(value.text);
  if (pageReady && view !== null) Web.emit(view, "notice", { text: value.text });
});
// Collision switch requested by the server (Core.Players.setNoCollision). Without collision the player would fall through the
// world, so gravity is suspended with it; they are given back in the order resetFall, setCollision(true), restoreGravity.
// Both calls return false while there is no pawn yet: retry briefly, latest request wins.
let collisionTimer = null, collisionWanted = true;
function applyCollision(tries) {
  collisionTimer = null;
  try {
    if (collisionWanted) { LocalPlayer.resetFall(); LocalPlayer.setCollision(true); LocalPlayer.restoreGravity(); return; }
    const g = LocalPlayer.suspendGravity(), c = LocalPlayer.setCollision(false);
    if ((g === false || c === false) && tries < 40) collisionTimer = setTimeout(() => applyCollision(tries + 1), 250);
  } catch (error) { console.log("[ms-core] collision switch failed: " + (error && error.message || error)); }
}
function setCollision(enabled) {
  collisionWanted = enabled;
  if (collisionTimer !== null) { clearTimeout(collisionTimer); collisionTimer = null; }
  applyCollision(0);
}
Events.on("ms-core:collision", value => {
  if (!value || typeof value.enabled !== "boolean") return;
  setCollision(value.enabled);
});
Events.on("resourceStart", name => { if (name === "ms-core") Events.emitServer("ms-core:sync"); });
Events.on("worldReady", () => Events.emitServer("ms-core:sync"));
Events.on("resourceStop", name => {
  if (name !== "ms-core") return;
  if (!collisionWanted) setCollision(true);
  closeView();
  LocalPlayer.restorePlayerInput();
  setLockedPages([]);
  Game.setPauseMenuEnabled(true);
  Game.setActionScreenEnabled(true);
  Game.setToolWheelEnabled(true);
});
