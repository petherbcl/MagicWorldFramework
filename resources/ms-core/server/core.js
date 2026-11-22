"use strict";
const crypto = require("node:crypto");
const { check, clone, metadata, observed, CoreError, publicId, isDatabaseUnavailable } = require("./validation");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function createCore({ repository, config, game, emit = () => {}, logger = console, clock = Date.now, databaseReady = () => true }) {
  const sessions = new Map(), accounts = new Map(), closingTasks = new Set();
  let closing = false, worldSequence = 0, checking = false, outageSince = null;
  const graceMs = config.outageGraceMs ?? 5 * 60 * 1000;
  const current = s => !closing && sessions.get(s.playerId) === s;
  const ensure = s => check(current(s), "SESSION_EXPIRED");
  const session = id => { const s = sessions.get(id); check(s && current(s), "SESSION_EXPIRED"); return s; };
  const rolesOf = s => s.game?.roles || ["player"];
  const permitted = (roles, permission) => roles.some(role => (config.rolePermissions[role] || []).some(grant => grant === "*" || grant === permission));
  const event = (name, value) => {
    try { Promise.resolve(emit(name, clone(value))).catch(() => logger.error("[ms-core] event handler failed: " + name)); }
    catch { logger.error("[ms-core] event handler failed: " + name); }
  };
  const snapshot = s => ({ sessionId: s.sessionId, playerId: s.playerId, userId: s.userId,
    status: s.status, authenticated: s.authenticated,
    allowlist: s.user?.allowlist || null, roles: rolesOf(s), metadata: s.user?.metadata || {},
    identifiers: { observed: s.observed }, credentialConfirmed: s.credentialConfirmed,
    inGame: s.game !== null, characterId: s.game?.characterId ?? null });
  // In-memory record of a player that picked a character and entered the game; roles are the character's and follow the polled database rows.
  const gameInfo = s => ({ playerId: s.playerId, userId: s.userId, sessionId: s.sessionId, characterId: s.game.characterId,
    roles: [...s.game.roles], enteredAt: s.game.enteredAt });
  function formUrl(userId) {
    if (!config.formUrl || !userId) return "";
    const url = new URL(config.formUrl); url.searchParams.set("id", userId); return url.href;
  }
  function send(s) {
    if (!current(s)) return;
    game.send(s.player, "ms-core:session", { sessionId: s.sessionId, status: s.status, serverKey: config.serverKey,
      userId: s.userId, allowlist: s.user?.allowlist || null, formUrl: formUrl(s.userId),
      lockedMenuPages: config.lockedMenuPages || [] });
    if (s.status === "awaitingCredentialStorage" && s.newCredential) {
      game.send(s.player, "ms-core:credential", { sessionId: s.sessionId, serverKey: config.serverKey, credential: s.newCredential });
    }
  }
  // Roles belong to the character: re-read them while the player is in game.
  async function refreshRoles(s) {
    const game = s.game; if (!game) return;
    const roles = await repository.characterRoles(game.characterId);
    ensure(s); if (s.game === game) game.roles = roles;
  }
  async function access(s) {
    ensure(s); check(s.authenticated && s.credentialConfirmed && s.userId, "NOT_AUTHENTICATED");
    const [user, ban, valid] = await Promise.all([repository.getUser(s.userId), repository.activeBan(s.userId), repository.verifyCredential(s.credentialHash, s.userId)]);
    check(valid, "INVALID_CREDENTIAL");
    ensure(s); check(user && user.allowlist === "approved", "ALLOWLIST_REQUIRED"); check(!ban, "ACCOUNT_BANNED");
    s.user = user; await refreshRoles(s); return user;
  }
  function detach(s, reason, kickMessage) {
    if (sessions.get(s.playerId) !== s) return Promise.resolve();
    s.status = "closed"; s.newCredential = null;
    if (s.game) { event("ms:playerLeftGame", { ...gameInfo(s), reason }); s.game = null; }
    sessions.delete(s.playerId);
    if (accounts.get(s.userId) === s) accounts.delete(s.userId);
    clearEffects(s);
    try { game.cancel(s); } catch { logger.error("[ms-core] native cleanup failed"); }
    if (kickMessage) game.kick(s.player, kickMessage);
    const task = s.persisting.then(async id => {
      if (id !== null) {
        await repository.endSession(id, reason);
        event("ms:sessionEnded", { sessionId: id, userId: s.userId, reason });
      }
    }).catch(() => logger.error("[ms-core] session close failed"));
    closingTasks.add(task); task.finally(() => closingTasks.delete(task)); return task;
  }
  async function attach(player, loaded = false) {
    check(!closing, "CORE_STOPPING");
    if (sessions.has(player.id)) await detach(sessions.get(player.id), "replaced");
    check(!closing && sessions.size < config.maxSessions, "SESSION_LIMIT");
    const s = { sessionId: null, persisting: Promise.resolve(null), playerId: player.id, player, observed: observed(player),
      userId: null, user: null, authenticated: false, credentialConfirmed: false, newCredential: null,
      status: "connecting", loaded,
      world: config.quarantineWorldBase + (++worldSequence), expiresAt: clock() + config.approvalTimeoutMs,
      registration: null, game: null };
    sessions.set(player.id, s);
    try {
      game.restrict(player, s);
      s.persisting = repository.startSession(player.id, config.serverKey);
      s.sessionId = await s.persisting;
      if (!current(s)) throw new CoreError("SESSION_EXPIRED");
      s.status = "identifying"; send(s);
      event("ms:sessionStarted", { sessionId: s.sessionId, playerId: s.playerId });
      return clone(snapshot(s));
    } catch (error) { if (current(s)) await detach(s, "registrationFailed", "Não foi possível preparar o registo."); throw error; }
  }
  async function evaluate(s) {
    ensure(s);
    const [user, ban, valid] = await Promise.all([repository.getUser(s.userId), repository.activeBan(s.userId), repository.verifyCredential(s.credentialHash, s.userId)]);
    check(valid, "INVALID_CREDENTIAL");
    ensure(s); check(user, "USER_NOT_FOUND"); s.user = user;
    await refreshRoles(s);
    if (ban || user.allowlist === "denied") {
      await detach(s, ban ? "banned" : "allowlistDenied", ban ? "Conta bloqueada: " + ban.reason : "O teu pedido de allowlist foi recusado."); return;
    }
    if (user.allowlist !== "approved") {
      if (s.status === "ready" || s.status === "waitingForWorld") {
        await detach(s, "accessRevoked", "O acesso à conta foi alterado."); return;
      }
      s.status = "awaitingApproval"; send(s); return;
    }
    if (s.status === "awaitingApproval" || s.status === "checkingAccess") {
      s.status = "waitingForWorld"; s.expiresAt = clock() + config.approvalTimeoutMs; send(s);
      event("ms:userAuthenticated", snapshot(s));
    }
    if (s.status === "waitingForWorld") enter(s);
  }
  // Approved, key verified and world loaded: leave quarantine. Characters belong to other resources.
  function enter(s) {
    if (!current(s) || s.status !== "waitingForWorld") return;
    if (!s.loaded) return; // loadingFinished calls enter again.
    game.release(s.player, s); s.status = "ready"; send(s);
    event("ms:playerReady", { playerId: s.playerId, sessionId: s.sessionId, userId: s.userId });
  }
  function register(playerId, input) {
    const s = session(playerId);
    check(input && input.sessionId === s.sessionId, "SESSION_EXPIRED");
    if (s.registration) return s.registration;
    check(s.status === "identifying", "INVALID_SESSION_STATE");
    const missing = missingIdentifiers(s.observed);
    if (missing) { s.registration = detach(s, "identifierMissing", missing).then(() => { throw new CoreError("IDENTIFIER_MISSING"); }); return s.registration; }
    let credential = input.credential;
    check(credential === null || (typeof credential === "string" && /^[A-Za-z0-9_-]{43}$/.test(credential)), "INVALID_CREDENTIAL");
    s.status = "registering";
    s.registration = (async () => {
      try {
        const issue = () => crypto.randomBytes(32).toString("base64url");
        let fresh = credential === null ? issue() : null, user;
        try { user = await repository.register(credential ? hash(credential) : null, fresh ? hash(fresh) : null, s.observed); }
        catch (error) {
          if (error.code !== "UNKNOWN_CREDENTIAL") throw error;
          // The stored key belongs to no account: register as a new client; the issued key replaces it.
          ensure(s); credential = null; fresh = issue();
          user = await repository.register(null, hash(fresh), s.observed);
        }
        ensure(s);
        check(!accounts.has(user.userId), "ACCOUNT_ALREADY_ONLINE");
        // Reserve before another asynchronous bind can admit the same account.
        s.userId = user.userId; s.user = user; s.credentialHash = hash(credential || fresh); accounts.set(user.userId, s);
        await repository.bindSession(s.sessionId, user.userId); ensure(s);
        s.authenticated = true;
        if (fresh) { s.newCredential = fresh; s.status = "awaitingCredentialStorage"; send(s); }
        else { s.credentialConfirmed = true; s.status = "checkingAccess"; await evaluate(s); }
        return clone(snapshot(s));
      } catch (error) {
        const message = error.code === "IDENTIFIER_ALREADY_REGISTERED" ? "Os teus identificadores já estão associados a uma conta. Usa a chave local original ou contacta a equipa para recuperar o acesso." :
          error.code === "IDENTIFIER_REQUIRED" ? "Não foi possível obter um identificador para o registo. Contacta a equipa." :
          error.code === "INVALID_CREDENTIAL" ? "A chave local deixou de ser válida. Contacta a equipa para recuperar a conta." : "Não foi possível identificar a conta.";
        if (current(s)) await detach(s, "identificationFailed", message);
        throw error;
      }
    })();
    return s.registration;
  }
  async function credentialStored(playerId, input) {
    const s = session(playerId);
    check(input && input.sessionId === s.sessionId, "SESSION_EXPIRED");
    if (s.credentialConfirmed) return; // Native/UI resynchronization may repeat the acknowledgement.
    check(s.status === "awaitingCredentialStorage", "INVALID_SESSION_STATE");
    s.newCredential = null; s.credentialConfirmed = true; s.status = "checkingAccess";
    try { await evaluate(s); }
    catch (error) { if (current(s)) await detach(s, "accessCheckFailed", "Não foi possível verificar o acesso."); throw error; }
  }
  const identifierHelp = {
    accountId: ["Conta ArcaneMP", "reinicia o jogo; a conta é criada pelo próprio jogo"],
    discordId: ["Discord", "abre a aplicação do Discord no PC (com sessão iniciada) antes de ligar"],
    steamId: ["Steam", "inicia o jogo pela Steam, com a Steam aberta e com sessão iniciada"],
    epicId: ["Epic Games", "inicia o jogo pela Epic Games Launcher, com sessão iniciada"],
    hardwareId: ["Identificador de hardware", "não foi possível obtê-lo; contacta a equipa"],
  };
  // Returns the pt-PT explanation for required identifier groups (AND of ORs) not satisfied, or "".
  function missingIdentifiers(source) {
    const announced = observed(source);
    const missing = (config.requiredIdentifiers || []).filter(group => !group.some(kind => announced[kind]));
    return missing.length ? "Este servidor exige: " + missing.map(group =>
      group.map(kind => identifierHelp[kind][0]).join(" ou ") + ": " + group.map(kind => identifierHelp[kind][1]).join("; ou ") + ".").join(" ") +
      " Depois volta a ligar." : "";
  }
  // Runs during the native handshake (loading screen), before any Player exists.
  // Only approved accounts are admitted; everyone else leaves with their numeric ID.
  async function admit(connection) {
    check(!closing, "CORE_STOPPING");
    check(sessions.size < config.maxSessions, "SESSION_LIMIT");
    const missing = missingIdentifiers(connection);
    if (missing) return { allowed: false, userId: null, allowlist: null, created: false, missing: true, message: missing };
    const user = await repository.admission(observed(connection));
    const ban = await repository.activeBan(user.userId);
    const id = "ID: " + user.userId;
    const result = (allowed, message) => ({ allowed, userId: user.userId, allowlist: user.allowlist, created: user.created, message });
    if (ban) return result(false, id + " bloqueado: " + ban.reason +
      (ban.expires_at ? " (até " + new Date(ban.expires_at).toISOString().slice(0, 16).replace("T", " ") + " UTC)." : "."));
    if (user.allowlist === "denied") return result(false, id + ": o pedido de allowlist foi recusado.");
    if (user.allowlist !== "approved") {
      const url = formUrl(user.userId);
      return result(false, id + (user.created ? " criado." : ".") + " Aguarda aprovação da allowlist. " +
        (url ? "Formulário: " + url : "Envia este ID à equipa.") + " Volta a ligar depois de aprovado.");
    }
    if (accounts.has(user.userId)) return result(false, id + ": esta conta já está ligada ao servidor.");
    return result(true, id + " aprovado. A entrar em Hogwarts...");
  }
  async function hasPermission(id, permission) {
    const s = sessions.get(id); if (!s || s.status !== "ready") return false;
    try { await access(s); return permitted(rolesOf(s), permission); } catch { return false; }
  }
  async function actor(id, permission) {
    const s = session(id);
    check(await hasPermission(id, permission), "FORBIDDEN"); ensure(s); return "user:" + s.userId;
  }
  async function loaded(id) {
    const s = session(id); s.loaded = true;
    // Never promote while the database can not confirm the account: tick() enters once it is back.
    if (s.status === "waitingForWorld") { if (databaseReady()) enter(s); }
    else if (s.status !== "ready") { game.restrict(s.player, s); send(s); }
  }
  // SEC-03: a database outage is not an authorization failure. Sessions already past the check stay as they
  // are and sessions still waiting are left untouched (never promoted without verification) until the database
  // answers again; only after `outageGraceMs` are sessions that are not ready released with the old kick.
  function noteOutage() {
    if (outageSince === null) { outageSince = clock(); logger.error("[ms-core] database unavailable: deferring access checks"); }
  }
  async function tick() {
    if (checking || closing) return; checking = true;
    try {
      let up = databaseReady();
      if (!up) noteOutage();
      for (const s of [...sessions.values()]) {
        if (!current(s)) continue;
        if (s.status !== "ready" && s.expiresAt <= clock()) { await detach(s, "timeout", "O tempo de espera terminou. Volta a ligar com o mesmo cliente."); continue; }
        if (up && s.userId && s.credentialConfirmed && !["checkingAccess", "registering"].includes(s.status)) {
          try { await evaluate(s); }
          catch (error) {
            if (!current(s)) continue;
            if (!isDatabaseUnavailable(error)) { await detach(s, "databaseUnavailable", "A base de dados está indisponível."); continue; }
            up = false; noteOutage();
          }
        }
        if (!up && s.status !== "ready" && current(s) && outageSince !== null && clock() - outageSince > graceMs) {
          await detach(s, "databaseUnavailable", "A base de dados está indisponível.");
        }
      }
      if (up && outageSince !== null) { outageSince = null; logger.error("[ms-core] database available again: access checks resumed"); }
    } finally { checking = false; }
  }
  // Shared player effects (invisible, no collision). Several resources may ask at once, so each request is keyed by an
  // owner and the effect is on while at least one owner holds it; the native call only happens when the effective state flips.
  const OWNER = /^[A-Za-z0-9:_.-]{1,64}$/;
  function effect(playerId, kind, owner, active, apply) {
    const s = session(playerId);
    check(s.status === "ready" && typeof owner === "string" && OWNER.test(owner) && typeof active === "boolean", "INVALID_EFFECT");
    const owners = (s.effects ||= { invisible: new Set(), noCollision: new Set() })[kind], before = owners.size > 0;
    if (active) owners.add(owner); else owners.delete(owner);
    const after = owners.size > 0;
    if (before !== after) apply(s, after);
    return after;
  }
  const applyInvisible = (s, on) => game.setVisible(s.player, !on, s);
  const applyNoCollision = (s, on) => game.setCollision(s.player, !on);
  // Session ending: give back whatever other resources took (the player may already be gone natively, so never throw).
  function clearEffects(s) {
    const e = s.effects; if (!e) return; s.effects = null;
    try { if (e.invisible.size) applyInvisible(s, false); } catch { /* player already gone */ }
    try { if (e.noCollision.size) applyNoCollision(s, false); } catch { /* player already gone */ }
  }
  const api = Object.freeze({
    version: "0.8.1",
    Users: Object.freeze({
      get: id => sessions.has(id) ? clone(snapshot(sessions.get(id))) : null,
      getOnlineById: id => accounts.has(String(id)) ? clone(snapshot(accounts.get(String(id)))) : null,
      isReady: id => sessions.get(id)?.status === "ready", hasPermission,
      load: async (id, source) => { await actor(source, "users.read"); return clone(await repository.getUser(publicId(id))); },
      setMetadata: async (id, key, value, source) => {
        id = publicId(id); const s = session(source);
        const self = s.userId === id && await hasPermission(source, "users.metadata.self");
        const author = self ? "user:" + s.userId : await actor(source, "users.metadata.write"); ensure(s);
        const user = await repository.setMetadata(id, key, metadata(key, value), author);
        if (accounts.has(id)) accounts.get(id).user = user; return clone(user.metadata);
      },
    }),
    // Characters belong to another resource: it tells ms-core when a ready player enters the game with one.
    Players: Object.freeze({
      enterGame: async (playerId, input) => {
        const s = session(playerId);
        check(input && typeof input.characterId === "string" && /^[0-9]{1,19}$/.test(input.characterId) && input.sessionId === s.sessionId, "INVALID_GAME_ENTRY");
        check(s.status === "ready", "INVALID_SESSION_STATE");
        if (s.game) { check(s.game.characterId === input.characterId, "ALREADY_IN_GAME"); return clone(gameInfo(s)); }
        await access(s); // fresh roles/allowlist/ban/key from the database before the player counts as in game
        ensure(s); check(s.status === "ready" && !s.game, "INVALID_SESSION_STATE");
        const roles = await repository.characterRoles(input.characterId); // the character's roles, fresh from the database
        ensure(s); check(s.status === "ready" && !s.game, "INVALID_SESSION_STATE");
        s.game = { characterId: input.characterId, roles, enteredAt: new Date(clock()).toISOString() };
        const info = gameInfo(s); event("ms:playerEnteredGame", info); return clone(info);
      },
      get: id => sessions.get(id)?.game ? clone(gameInfo(sessions.get(id))) : null,
      getByUserId: id => accounts.get(String(id))?.game ? clone(gameInfo(accounts.get(String(id)))) : null,
      isInGame: id => Boolean(sessions.get(id)?.game),
      // Owner-keyed effects, only for a ready session. Returns whether the effect is now on (for any owner).
      setInvisible: (playerId, owner, enabled) => effect(playerId, "invisible", owner, enabled, applyInvisible),
      setNoCollision: (playerId, owner, enabled) => effect(playerId, "noCollision", owner, enabled, applyNoCollision),
      isInvisible: id => (sessions.get(id)?.effects?.invisible.size || 0) > 0,
      hasNoCollision: id => (sessions.get(id)?.effects?.noCollision.size || 0) > 0,
      getAll: () => [...sessions.values()].filter(s => s.game).map(s => clone(gameInfo(s))),
    }),
    Allowlist: Object.freeze({
      approve: async (id, source) => { const result = await repository.setAllowlist(publicId(id), "approved", await actor(source, "allowlist.manage")); await tick(); return clone(result); },
      deny: async (id, reason, source) => { const result = await repository.setAllowlist(publicId(id), "denied", await actor(source, "allowlist.manage"), reason); await tick(); return clone(result); },
    }),
    Roles: Object.freeze({ set: async (characterId, role, enabled, source) => {
      const author = await actor(source, "roles.manage"); check(Object.hasOwn(config.rolePermissions, role) && role !== "player" && typeof enabled === "boolean", "INVALID_ROLE");
      const result = await repository.setRole(publicId(characterId), role, enabled, author); await tick(); return clone(result);
    } }),
    Bans: Object.freeze({
      add: async (id, reason, expiresAt, source) => { const value = await repository.ban(publicId(id), reason, expiresAt, await actor(source, "bans.manage")); await tick(); return value; },
      revoke: async (id, source) => repository.unban(publicId(id), await actor(source, "bans.manage")),
    }),
  });
  return { api, admit, attach, register, credentialStored, loaded, tick,
    guard(id) { const s = sessions.get(id); return () => Boolean(s && current(s)); },
    sync(id) { send(session(id)); },
    disconnect(id) { const s = sessions.get(id); return s ? detach(s, "disconnect") : Promise.resolve(); },
    async stop() { if (closing) return; closing = true; await Promise.all([...sessions.values()].map(s => detach(s, "resourceStop", "A framework reiniciou. Volta a ligar."))); await Promise.all([...closingTasks]); },
  };
}
module.exports = { createCore };
