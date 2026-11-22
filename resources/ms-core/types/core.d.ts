/** ms-core 0.8.1 server-only API. BIGINT public IDs use decimal strings for precision. */
export type PublicId = string;
export type SessionStatus = "connecting" | "identifying" | "registering" | "awaitingCredentialStorage" |
  "checkingAccess" | "awaitingApproval" | "waitingForWorld" | "ready" | "closed";
export type AllowlistStatus = "pending" | "approved" | "denied";
export interface User { userId: PublicId; allowlist: AllowlistStatus; metadata: Record<string, unknown>; createdAt: string; lastSeenAt: string; }
export interface Session {
  /** Numeric database ID; null only while the connecting session awaits its INSERT. */
  sessionId: PublicId | null; playerId: number; userId: PublicId | null;
  status: SessionStatus; authenticated: boolean; credentialConfirmed: boolean; allowlist: AllowlistStatus | null;
  roles: string[]; metadata: Record<string, unknown>; identifiers: { observed: Record<string, string> };
  /** True once a resource called Players.enterGame for this session. */
  inGame: boolean; characterId: PublicId | null;
}
/** In-memory record of a player that entered the game with a character. `roles` are the character's roles (always includes "player") and follow the polled database rows. */
export interface GamePlayer { playerId: number; userId: PublicId; sessionId: PublicId; characterId: PublicId; roles: string[]; enteredAt: string; }
/** ms:playerEnteredGame payload (same as GamePlayer). ms:playerLeftGame adds the session end `reason`. */
export type PlayerLeftGame = GamePlayer & { reason: string };
/** ms:playerReady payload: approved account, verified key, world loaded, quarantine released. */
export interface PlayerReady { playerId: number; sessionId: PublicId; userId: PublicId; }
export interface Core {
  readonly version: string;
  readonly Users: {
    get(playerId: number): Session | null;
    getOnlineById(userId: PublicId): Session | null;
    load(userId: PublicId, actorPlayerId: number): Promise<User | null>;
    isReady(playerId: number): boolean;
    hasPermission(playerId: number, permission: string): Promise<boolean>;
    setMetadata(userId: PublicId, key: string, value: unknown, actorPlayerId: number): Promise<Record<string, unknown>>;
  };
  readonly Players: {
    /** The ready session `sessionId` enters the game with `characterId`: re-checks the account and keeps the player in memory. Idempotent for the same character. */
    enterGame(playerId: number, input: { sessionId: PublicId; characterId: PublicId }): Promise<GamePlayer>;
    get(playerId: number): GamePlayer | null;
    getByUserId(userId: PublicId): GamePlayer | null;
    isInGame(playerId: number): boolean;
    getAll(): GamePlayer[];
    /**
     * Makes a ready player invisible (or visible again). Each resource passes its own `owner` (1-64 chars of `A-Za-z0-9:_.-`):
     * the player stays invisible while at least one owner holds it. Returns whether the effect is now on. Throws `INVALID_EFFECT`
     * (not ready, bad owner/flag) or `SESSION_EXPIRED`. Cleared automatically when the session ends.
     */
    setInvisible(playerId: number, owner: string, enabled: boolean): boolean;
    /**
     * Removes (`enabled = true`) or gives back (`false`) the player's world collision, same owner rules as `setInvisible`.
     * Applied by the player's client together with suspended gravity, so the player floats instead of falling through the world.
     */
    setNoCollision(playerId: number, owner: string, enabled: boolean): boolean;
    isInvisible(playerId: number): boolean;
    hasNoCollision(playerId: number): boolean;
  };
  readonly Allowlist: {
    approve(userId: PublicId, actorPlayerId: number): Promise<User>;
    deny(userId: PublicId, reason: string, actorPlayerId: number): Promise<User>;
  };
  readonly Roles: { set(characterId: PublicId, role: string, enabled: boolean, actorPlayerId: number): Promise<string[]>; };
  readonly Bans: {
    add(userId: PublicId, reason: string, expiresAt: number | null, actorPlayerId: number): Promise<PublicId>;
    revoke(userId: PublicId, actorPlayerId: number): Promise<void>;
  };
}
