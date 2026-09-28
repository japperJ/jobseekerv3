# ADR 0002 — opencode provider on the v2 API

- **Status:** Implemented
- **Date:** 2026-09-28
- **Deciders:** japperJ
- **Supersedes:** the opencode SDK mapping in [ADR 0001](0001-llm-provider-abstraction.md)
- **Related:** `src/llm/opencode-provider.ts`, `src/llm/opencode-provider.test.ts`, `src/config.ts`

## Context

The opencode provider built per ADR 0001 never worked against a current `opencode`
install. It is written against the SDK's **v1** client surface
(`client.global.health()`, `client.config.providers()`,
`client.session.create/prompt/abort/delete()`, `client.event.subscribe()`), and the
CLI is now at **v2.0.x**. Four independent things break:

1. **Every route moved.** v2 serves its API under `/api/*`. The v1 paths
   (`/global/health`, `/config/providers`, `/session`, `/event`) no longer exist and
   fall through to the SPA, so the SDK's response interceptor rejects them with
   *"Request is not supported by this version of OpenCode Server"*. The same
   `@opencode-ai/sdk` package ships the v2 client as `client.v2.*`; the provider was
   simply calling the wrong namespace.
2. **The API requires auth.** v2 rejects unauthenticated requests with
   `401 UnauthorizedError`. The credential is HTTP Basic, `opencode:<password>`, and the
   password comes from the `OPENCODE_SERVER_PASSWORD` env var on the server side.
   The SDK's `createOpencode()` neither sets that var nor returns the password, so a
   server it spawns is unreachable — every call 401s.
3. **The SDK's spawn timeout is unusable.** `createOpencodeServer()` defaults to
   5000 ms. A cold `opencode serve` on Windows takes 5–15 s, so spawning fails before
   the port is open.
4. **A spawn-time config clobber.** `createOpencodeServer()` sets
   `OPENCODE_CONFIG_CONTENT` to `"{}"`, which would drop the tool-free agent this app
   needs.

## Decision

Drive the v2 API through the SDK's `client.v2.*` namespace, and own the server
lifecycle ourselves.

### API mapping

The CLI's API lives under `/api/*` and requires HTTP Basic auth
(`opencode:<password>`). The routes this app needs:

| Capability | Call |
|---|---|
| Health | `GET /api/health` → `{ data: { healthy } }` |
| List models | `GET /api/model` → `{ data: [{ providerID, id, enabled }] }`, flattened to `opencode/<providerID>/<id>` |
| Create session | `POST /api/session` → `{ data: { id } }` |
| Send prompt | `POST /api/session/{id}/prompt` with a **flat** `{ text, delivery: "queue", resume: true }` body |
| Await reply | poll `GET /api/session/{id}/message?order=asc` until an assistant message has a `finish` |
| Cancel | `POST /api/session/{id}/interrupt` |
| Streaming | `GET /api/event` (SSE), filtered to `session.text.delta` for this session |

`delivery: "queue"` keeps a single prompt from being cut short, and `resume: true` is
what actually schedules the agent loop — without it the input is durably admitted and
nothing ever runs.

`session.wait()` exists in the SDK but the server answers
`ServiceUnavailableError: "Session wait is not available yet"`, so the transcript poll
is the completion signal. Polling every 400 ms also keeps the final text correct even
if the event stream is missed, since the reply is read from the transcript rather than
accumulated from deltas.

### Why not `@opencode-ai/sdk`

The first implementation of this ADR used the SDK's `client.v2.*` namespace. It does
not work, and the reason is not a bug in this app: **`@opencode-ai/sdk` is generated
from the opencode 1.18.x OpenAPI document, and its latest published version is
1.18.33 — there is no 2.x release.** Against a 2.0.x server it disagrees on exactly the
two calls this app cannot do without:

| Operation | SDK (1.18.x spec) | CLI 2.0.x (observed) |
|---|---|---|
| Send a prompt | `POST /api/session/{id}/prompt`, nested `{ prompt: { text } }` | same route, flat `{ text }` body → `400 Missing key at ["text"]` |
| Read the transcript | `GET /api/session/{id}/messages` | `GET /api/session/{id}/message` (singular) → 404 |
| Text deltas | `session.next.text.delta` | `session.text.delta` |

So the provider now speaks HTTP directly (`src/llm/opencode-client.ts`, ~200 lines)
and the SDK dependency was dropped. Health, model listing, session creation, and
interrupting all agreed, but keeping a client for those and hand-rolling the rest would
have been two APIs to maintain for no benefit.

### Server lifecycle

`spawnServer()` in `opencode-provider.ts` starts `opencode serve` directly instead of
using `createOpencode()`, so it can set `OPENCODE_SERVER_PASSWORD` (random per process),
`OPENCODE_CONFIG_CONTENT` (the tool-free agent), and a 60 s start timeout. The SDK's
`createOpencode()` cannot be used for any of those three.

Two more server facts shaped the code:

- **The startup banner differs between builds** — `opencode server listening on <url>`
  on 1.18.x, `server listening on <url>` on 2.0.x. The parser matches either.
- **`opencode serve` reports its URL before it is usable.** For the first few seconds
  `/api/health` 404s and `/api/model` returns an empty catalog while the provider
  catalog loads. `awaitReady()` polls until the server answers, otherwise the app
  reports the provider as down and shows an empty model dropdown on a healthy server.

### Which opencode build

opencode builds are **not** database-schema compatible with each other, and on Windows
a bare `opencode` resolves through PATHEXT, which can pick the wrong one. The machine
this was built on has both:

| Path | Version | Schema |
|---|---|---|
| `…\scoop\apps\opencode\current\opencode.exe` | 1.18.26 | needs `session_input` |
| `…\nvm4w\nodejs\…\@opencode\cli\bin\opencode.exe` | 2.0.15 | matches the current `opencode.db` |

Spawning the 1.18.26 build against the 2.0.x-migrated database fails every prompt with
`SQLiteError: no such table: session_input`, surfacing to the user as the opaque
`opencode prompt failed: Unexpected server error`. Hence `OPENCODE_BIN`, documented in
`.env.example` and set in `.env`.

### Credentials

| Mode | Password source |
|---|---|
| Spawned (default) | random, generated per process and passed to the child |
| Attached via `OPENCODE_BASE_URL` | `OPENCODE_PASSWORD` → `OPENCODE_SERVER_PASSWORD` → `password` in `~/.config/opencode/service.json` |

Attaching with no discoverable password throws with instructions rather than
silently 401ing.

### System prompt, schema, and tools

The prompt endpoint takes only `{ text }` — no system prompt, no tool overrides, no
structured-output format. So:

- **System prompt** is prepended to the user text inside `<system-instructions>`.
  (ADR 0001's "prepend" option, chosen because the system prompt differs per call and
  an agent can only carry one.)
- **`jsonSchema`** is appended as a `<json-schema>` block with an instruction to emit
  raw JSON. This is safe because every caller already parses with `extractJson`.
- **Tools** come from an agent, selected per session. opencode's default `build` agent
  has shell and file tools this app must not expose, so the spawned server is given a
  `jobseeker` primary agent via `OPENCODE_CONFIG_CONTENT` with an explicit
  `{ tool: false }` map plus `permission: { tool: "deny" }`. An empty tools map means
  "inherit", so each tool is turned off by name. Verified: a session on this agent
  reports `tools: none` and cannot list files. An *attached* server is not forced onto
  this agent, since it does not know the name.

### Session isolation

opencode scopes sessions to a project directory. The provider points it at a scratch
directory under the OS temp dir, so this app's sessions do not fill the user's session
list for their real projects. There is no session-delete endpoint, so sessions cannot be
cleaned up individually — isolation is the only lever available.

## Consequences

- Model IDs for opencode read `opencode/<providerID>/<modelID>`, e.g.
  `opencode/opencode-go/space-bunny-free`. The outer prefix is this app's routing
  prefix; the inner one is opencode's.
- The model list is whatever the connected server is signed in to, so it varies by
  machine. `listModels()` validates the selected model against the live catalog, so a
  typo fails loudly instead of silently falling back.
- Requires the `opencode` CLI on `PATH`, and `OPENCODE_BIN` when more than one build is
  installed.
- `ProviderModels` gained an `error` field so `/api/models` can say *why* a provider
  group is empty; previously an unreachable provider was indistinguishable from one
  with no models.
- `@opencode-ai/sdk` is no longer a dependency. Nothing else in the app used it, and
  keeping it would have meant maintaining a client for endpoints the app does not call.

## Verified

Against opencode 2.0.15 on a real `opencode.db`, with `opencode/opencode-go/space-bunny-free`:

- `/api/health` reports the opencode provider up; `/api/models` lists 356 opencode
  models (29 of them `opencode-go`).
- A prompt returns in ~8 s; the streamed deltas reassemble exactly to the final text.
- `systemPrompt` + `jsonSchema` produce valid JSON (`{"ok":true}`).
- Through the app's own `POST /api/message`, a Danish request is parsed into a
  structured job in ~10 s.
- The session reports `agent: jobseeker` and `tools: none`.

