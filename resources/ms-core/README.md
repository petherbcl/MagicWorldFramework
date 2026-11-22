# ms-core

Framework base do MagicSchoolRP (versão 0.8.1). Gere contas (PostgreSQL, MySQL ou MariaDB através do [ms-sql](../ms-sql/README.md)) com ID numérico, admissão no ecrã de entrada, allowlist externa, chave local, roles e bans. A especificação completa (fluxo, esquema, SQL para a aplicação do formulário, recuperação de contas) está em [docs/MS_CORE.md](../../docs/MS_CORE.md).

**Fora do âmbito:** personagens. A criação, a seleção e a persistência (inventário, look e localização) ficam no recurso [ms-character](../ms-character/README.md), que depende do ms-core, abre o lobby de personagens no `ms:playerReady` e associa as personagens ao `userId`.

## Fluxo

1. **Ecrã de entrada (`playerConnecting`).** O core valida os identificadores obrigatórios e encontra a conta pelos IDs Steam, Epic, Discord ou de hardware. Se não existir conta, cria um registo `pending`. O resultado aparece no próprio ecrã "Joining":
   - **Pendente:** mostra `ID: 123 criado. Aguarda aprovação da allowlist. Formulário: …` e recusa a entrada.
   - **Recusado, banido ou já ligado:** mostra a recusa com o ID e o motivo.
   - **Aprovado:** deixa entrar.
2. **No jogo.** O jogador fica numa quarentena: mundo privado, invisível e preso ao spawn. O cliente apresenta a chave local guardada no storage CEF. Se ainda não tiver chave, recebe uma nova.
3. **Pronto.** Com a conta aprovada, a chave verificada e o mundo carregado, o core liberta a quarentena e emite `ms:playerReady`.

Identificadores na conta:
- Só são acrescentados tipos que a conta ainda não tinha. Um Discord, Steam, Epic ou hardware ID diferente do registado é ignorado.
- IP, nickname e nome Discord são atualizados para o valor mais recente.

## Configuração

Copiar [.env.example](.env.example) para `.env`. As variáveis definidas no ambiente do processo têm prioridade sobre o ficheiro. A base de dados **não** se configura aqui: `MS_SQL_URL` e o pool definem-se em `resources/ms-sql/.env`. Sem `MS_SQL_URL` no ms-sql, a admissão fica fechada.

| Variável | Default | Função |
| --- | --- | --- |
| `MS_SERVER_KEY` | MagicSchoolRP | Namespace do servidor e do storage local |
| `MS_ALLOWLIST_FORM_URL` | vazio | URL do formulário; recebe `?id=<ID>` |
| `MS_REQUIRED_IDENTIFIERS` | vazio | Identificadores obrigatórios; `,` = E, `\|` = OU |
| `MS_APPROVAL_TIMEOUT_SECONDS` | 1800 | Prazo das fases pendentes, 60–86400 |
| `MS_ACCESS_POLL_SECONDS` | 5 | Intervalo de revisão de acesso, 1–60 |

Exemplo: exigir Discord e Steam ou Epic.

```
MS_REQUIRED_IDENTIFIERS=discordId,steamId|epicId
```

Quando falta um identificador obrigatório, o jogador vê o que tem de fazer, por exemplo abrir a aplicação do Discord antes de ligar.

## Comandos

Executar a partir da pasta que contém `server.json`. Na PowerShell, usar `npm.cmd`.

```powershell
npm.cmd ci --prefix resources/ms-core           # dependências (inclui as de teste)
npm.cmd test --prefix resources/ms-core         # testes (PGlite embebido, não toca na BD real)
node resources/ms-core/tools/smoke-runtime.js   # arranca o ArcaneMPServer.exe real numa pasta isolada
node resources/ms-core/tools/admin.js --help    # administração local
```

Comandos de administração: `users`, `show`, `approve`, `deny`, `role-add`, `role-remove`, `ban`, `unban`, `recover <pendente> <original>` e `reset-key <id>`. O `reset-key` revoga as chaves da conta; o próximo cliente com os mesmos identificadores recebe uma chave nova. Todas as operações ficam na auditoria.

## Integração com outros recursos

Declarar `"resourceDependencies": ["ms-core"]` no manifesto `mafiahub` e confirmar a sessão antes de agir:

```javascript
const Core = Exports.get("ms-core", "Core");
Events.on("ms:playerReady", ({ playerId, sessionId, userId }) => {
  if (Core.Users.get(playerId)?.sessionId !== sessionId || !Core.Users.isReady(playerId)) return;
  // Carregar ou criar a personagem de userId.
});
```

- Os IDs são strings decimais (`"123"`). A lista completa de funções e eventos, com exemplos, está nas secções seguintes.

## API (`Core`)

Só existe no servidor (`Exports.get("ms-core", "Core")`). Os IDs de conta, sessão, ban e personagem são **strings decimais** (`"123"`); `playerId` é o número temporário do jogo. As funções `get*`, `is*` e `getAll` são síncronas e devolvem cópias. As restantes devolvem uma `Promise`. Os tipos completos estão em [types/core.d.ts](types/core.d.ts).

As funções que alteram dados recebem o `playerId` de quem as executa (`actorPlayerId`). A cada chamada o core confirma na BD que essa sessão está `ready` e tem a permissão necessária; senão rejeita com `FORBIDDEN`. Permissões por role (`server/config.js`): `player` → `users.metadata.self`; `moderator` → `users.read`, `allowlist.manage`, `bans.manage`; `admin` → tudo (`*`).

### `Core.version`

```javascript
Core.version; // "0.8.1"
```

### `Core.Users`

| Função | Descrição |
| --- | --- |
| `get(playerId)` | Sessão do jogador ou `null`. Não inclui a chave local. |
| `getOnlineById(userId)` | Igual a `get`, mas pelo ID da conta (só contas ligadas). |
| `isReady(playerId)` | `true` quando a conta está aprovada, a chave verificada e o mundo carregado (`status: "ready"`). |
| `hasPermission(playerId, permission)` | `true` se algum role da conta concede a permissão. Reverifica a conta na BD. |
| `load(userId, actorPlayerId)` | Lê a conta na BD. Exige `users.read`. |
| `setMetadata(userId, key, value, actorPlayerId)` | Grava um valor nos metadados da conta e devolve todos os metadados. A própria conta pode alterar os seus (`users.metadata.self`); as outras exigem `users.metadata.write`. |

```javascript
Core.Users.get(3);
// {
//   sessionId: "57", playerId: 3, userId: "12",
//   status: "ready", authenticated: true, credentialConfirmed: true,
//   allowlist: "approved", roles: ["player", "moderator"], // da personagem em jogo; ["player"] fora de jogo
//   metadata: { discordTag: "ana#0001" },
//   identifiers: { observed: { discordId: "123456789", steamId: "7656119..." } },
//   inGame: true, characterId: "8"   // ver Core.Players
// }
Core.Users.isReady(3);                            // true
Core.Users.getOnlineById("12")?.playerId;         // 3
await Core.Users.hasPermission(3, "bans.manage"); // true
await Core.Users.load("12", 3);
// { userId: "12", allowlist: "approved", metadata: { discordTag: "ana#0001" },
//   createdAt: "2026-11-17T10:02:11.000Z", lastSeenAt: "2026-11-19T16:30:02.000Z" }
await Core.Users.setMetadata("12", "language", "pt-PT", 3);
// { discordTag: "ana#0001", language: "pt-PT" }
```

Estados da sessão (`status`): `connecting` → `identifying` → `registering` → (`awaitingCredentialStorage`) → `checkingAccess` → `awaitingApproval` → `waitingForWorld` → `ready` → `closed`.

### `Core.Players` (desde a 0.7.0)

Jogadores que já escolheram uma personagem e estão em jogo. Quem chama `enterGame` é o recurso de personagens (ms-character), logo depois de libertar o jogador no mundo.

| Função | Descrição |
| --- | --- |
| `enterGame(playerId, { sessionId, characterId })` | Regista que o jogador entra em jogo com a personagem. Exige sessão `ready` e o `sessionId` certo, volta a validar a conta na BD (chave, allowlist, ban) e guarda o registo em memória. Emite `ms:playerEnteredGame`. Repetir com a mesma personagem devolve o mesmo registo; outra personagem na mesma sessão falha com `ALREADY_IN_GAME`. |
| `get(playerId)` | Registo em memória ou `null`. |
| `getByUserId(userId)` | Igual, pelo ID da conta. |
| `isInGame(playerId)` | `true` se o jogador está em jogo. |
| `getAll()` | Lista de todos os jogadores em jogo. |
| `setInvisible(playerId, owner, enabled)` | (0.8.0) Torna o jogador invisível ou visível. Devolve se o efeito ficou ativo. |
| `setNoCollision(playerId, owner, enabled)` | (0.8.0) `true` tira a colisão ao jogador, `false` devolve-a. O cliente suspende também a gravidade, para o jogador não cair do mundo. |
| `isInvisible(playerId)` / `hasNoCollision(playerId)` | (0.8.0) Estado atual. |

**Efeitos partilhados (0.8.0):** cada recurso passa o seu `owner` (por exemplo `"ms-spawn:preview"`). O efeito está ativo enquanto houver pelo menos um owner, por isso dois recursos não se anulam. Exigem sessão `ready` (`INVALID_EFFECT` caso contrário) e são repostos quando a sessão termina. Quem pede tem de os desligar com o mesmo `owner`.

Os `roles` são os da personagem (tabela `ms_character_roles`; `player` é implícito) e o core relê-os a cada `MS_ACCESS_POLL_SECONDS`, por isso uma alteração de roles aparece com esse atraso. O registo desaparece quando a sessão termina.

```javascript
await Core.Players.enterGame(3, { sessionId: "57", characterId: "8" });
// { playerId: 3, userId: "12", sessionId: "57", characterId: "8",
//   roles: ["player", "moderator"], enteredAt: "2026-11-19T16:40:12.331Z" }
Core.Players.isInGame(3);   // true
Core.Players.get(3)?.roles; // ["player", "moderator"]
Core.Players.getAll();      // [ { playerId: 3, userId: "12", ... } ]
Core.Players.get(99);       // null
```

### `Core.Allowlist`

| Função | Descrição |
| --- | --- |
| `approve(userId, actorPlayerId)` | Aprova a conta (`allowlist.manage`). Se o jogador está ligado, o core revê o acesso de imediato e liberta-o. |
| `deny(userId, reason, actorPlayerId)` | Recusa a conta e regista o motivo (`allowlist.manage`). Se estiver ligado, é desligado. |

```javascript
await Core.Allowlist.approve("15", 3);
// { userId: "15", allowlist: "approved", metadata: {}, createdAt: "...", lastSeenAt: "..." }
await Core.Allowlist.deny("16", "Formulário incompleto", 3); // igual, com allowlist: "denied"
```

### `Core.Roles`

| Função | Descrição |
| --- | --- |
| `set(characterId, role, enabled, actorPlayerId)` | Liga (`true`) ou desliga (`false`) um role da personagem (`roles.manage`; devolve os roles da personagem). O role tem de existir em `rolePermissions` e não pode ser `player` (implícito), senão `INVALID_ROLE`. |

```javascript
await Core.Roles.set("8", "moderator", true, 3); // ["player", "moderator"]
```

### `Core.Bans`

| Função | Descrição |
| --- | --- |
| `add(userId, reason, expiresAt, actorPlayerId)` | Bloqueia a conta (`bans.manage`). `expiresAt` é um timestamp em ms no futuro, ou `null` para um ban permanente. Se estiver ligada, a conta é desligada. Devolve o ID do ban. |
| `revoke(userId, actorPlayerId)` | Levanta os bans ativos da conta (`bans.manage`). Não devolve nada. |

```javascript
await Core.Bans.add("15", "Insultos no chat", Date.now() + 7 * 24 * 3600 * 1000, 3); // "4"
await Core.Bans.add("16", "Cheats", null, 3);                                          // "5" (permanente)
await Core.Bans.revoke("15", 3);                                                       // undefined
```

### Erros

As funções rejeitam com um erro que tem `code`. Os mais comuns: `SESSION_EXPIRED` (a sessão já não existe), `FORBIDDEN` (falta a permissão), `INVALID_SESSION_STATE` (a sessão não está `ready`), `USER_NOT_FOUND`, `INVALID_ROLE`, `INVALID_GAME_ENTRY`, `ALREADY_IN_GAME`, `ACCOUNT_BANNED` e `ALLOWLIST_REQUIRED`.

```javascript
try { await Core.Bans.add("15", "x", null, 99); }
catch (error) { error.code; } // "SESSION_EXPIRED"
```

## Eventos de servidor

Os payloads são cópias. Confirma sempre a sessão (`Core.Users.get(playerId)?.sessionId === sessionId`) antes de agir, porque o `playerId` é reutilizado.

| Evento | Quando | Payload de exemplo |
| --- | --- | --- |
| `ms:sessionStarted` | Sessão criada, ainda sem conta. | `{ sessionId: "57", playerId: 3 }` |
| `ms:userAuthenticated` | Conta aprovada, à espera do mundo. | Sessão (como `Users.get`) |
| `ms:playerReady` | Conta aprovada, chave verificada, mundo carregado, quarentena libertada. | `{ playerId: 3, sessionId: "57", userId: "12" }` |
| `ms:playerEnteredGame` | `Players.enterGame` concluído (personagem escolhida). | `{ playerId: 3, userId: "12", sessionId: "57", characterId: "8", roles: ["player"], enteredAt: "2026-11-19T16:40:12.331Z" }` |
| `ms:playerLeftGame` | A sessão de um jogador em jogo terminou. | O mesmo que `ms:playerEnteredGame`, mais `reason: "disconnect"` |
| `ms:sessionEnded` | Sessão terminada (desligar, kick, ban, timeout, reinício). | `{ sessionId: "57", userId: "12", reason: "disconnect" }` |

```javascript
Events.on("ms:playerEnteredGame", ({ playerId, userId, characterId, roles }) => {
  if (!Core.Players.isInGame(playerId)) return;
  console.log(`jogador ${playerId} (conta ${userId}, personagem ${characterId}) entrou com os roles ${roles.join(", ")}`);
});
```
