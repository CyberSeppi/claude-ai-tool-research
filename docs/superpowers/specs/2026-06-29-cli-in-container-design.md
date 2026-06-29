# Design — `LLM_PROVIDER=cli` Reliable Inside the Container

Date: 2026-06-29
Status: Approved — autonomous implementation

## Context

`LLM_PROVIDER=cli` works when the host has a Pro/Max OAuth session
(`~/.claude/.credentials.json` contains a `claudeAiOauth` block) and the
container mounts that file in. On this dev machine that block is absent;
`claude` on the host is a wrapper that routes through a local
claude-code-router (CCR) on `:3456` toward an OpenAI-compatible corporate
gateway. The container's bundled CLI sees no Pro/Max OAuth, falls back to
"Not logged in", and the chat dies on first request.

This spec makes `cli` provider work for **three Anthropic-compatible
endpoints**, generically — no BMW or vendor names in committed code:

1. `api.anthropic.com` direct, authenticated with an
   `ANTHROPIC_API_KEY` from the env.
2. `api.anthropic.com` direct, authenticated with a Pro/Max OAuth
   session mounted from `~/.claude/`.
3. A local host service that speaks the Anthropic protocol on a
   port the user configures (any router: CCR, litellm, claude-bridge,
   …). Routed via `host.docker.internal`.

The app code only knows about the three official Anthropic SDK env
variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`). What runs behind the URL is the user's
problem — exactly the same generic stance `.env.example` already takes
for `LLM_API_BASE_URL`.

## Non-goals

- No bundled router (no litellm, no claude-bridge). The user owns
  whatever proxy they run.
- No router protocol translation in our code. If a user's router rejects
  Anthropic-shaped requests, that's a router-config issue, not ours.
- No new abstraction layer. We do not invent a "router profile" or
  "auth strategy" plugin system. Three env vars + a mount.

## Architecture

### Three supported `cli` setups

| Setup | What user sets in `.env` | Mount |
|---|---|---|
| Anthropic API key | `ANTHROPIC_API_KEY=sk-ant-…` | — |
| Anthropic Pro/Max OAuth | (nothing — uses mount) | `~/.claude/` + `~/.claude.json` from host (auto by `run.sh`) |
| Local Anthropic-compat router | `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>`, `ANTHROPIC_AUTH_TOKEN=<router-key>` | `~/.claude/` (still mounted, harmless if unused) |

`run.sh` passes the three env vars through **only when set**. Adds
`--add-host=host.docker.internal:host-gateway` whenever the cli provider
might be used (i.e., on every run — cheap, no side effect when unused).
This is exactly what `run.sh` already does today; we just need to
verify and clean up the existing flow.

### Pre-flight auth check (new)

When `LLM_PROVIDER=cli`, the app refuses to start unless **at least one**
of the three credential paths is satisfied:

1. `ANTHROPIC_API_KEY` is set in env, OR
2. `ANTHROPIC_AUTH_TOKEN` is set in env (router mode), OR
3. `~/.claude/.credentials.json` contains a non-empty
   `claudeAiOauth.accessToken` field (Pro/Max mode)

If none of the above, the app logs a precise diagnostic at boot and
exits non-zero. Message includes the three remedies verbatim. The user
can then either fix the env / mount or switch to `LLM_PROVIDER=api`.

This converts a runtime "Not logged in" error (from the SDK, surfaced
in a chat reply) into a boot-time error that ops/users can read in
`docker logs` before anyone hits the chat.

### `provider-cli.mjs` — explicit env to the SDK subprocess

Today the SDK inherits `process.env`. That's fine, but means a stray
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787` in the user's shell env
silently breaks the container. We tighten the spawn:

```js
const subprocessEnv = {
  ...process.env,
  CLAUDE_AGENT_SDK_CLIENT_APP: "claude-ai-tool-research/1.0",
};
// If we resolved an effective base URL/auth at config-load time,
// inject them here so the subprocess gets exactly what we expect.
if (cfg.cliEffective?.baseUrl) subprocessEnv.ANTHROPIC_BASE_URL = cfg.cliEffective.baseUrl;
if (cfg.cliEffective?.authToken) subprocessEnv.ANTHROPIC_AUTH_TOKEN = cfg.cliEffective.authToken;
if (cfg.cliEffective?.apiKey) subprocessEnv.ANTHROPIC_API_KEY = cfg.cliEffective.apiKey;
```

Plus pass `env: subprocessEnv` to `query()` so the subprocess gets
exactly what we resolved, not what's lying around in the shell.

### Config additions (`llm/config.mjs`)

A small block resolved alongside the existing `LlmConfig`:

```js
cliEffective: {
  baseUrl: env.ANTHROPIC_BASE_URL?.trim() || null,   // null = SDK default = api.anthropic.com
  authToken: env.ANTHROPIC_AUTH_TOKEN?.trim() || null,
  apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
  // Resolved auth mode for logging + the boot pre-flight check.
  // 'api-key' | 'oauth-token' | 'mount' | 'none'
  mode: pickAuthMode(env, credentialsPath),
}
```

`pickAuthMode` priority (matches SDK precedence — explicit env wins over
mount):
1. `ANTHROPIC_API_KEY` set → `'api-key'`
2. `ANTHROPIC_AUTH_TOKEN` set → `'oauth-token'`
3. `~/.claude/.credentials.json` has `claudeAiOauth.accessToken` → `'mount'`
4. otherwise → `'none'`

Pre-flight rejects `mode === 'none'`.

`credentialsPath` defaults to `${process.env.HOME}/.claude/.credentials.json`.
Injectable for tests.

### `run.sh` — already does the right thing, just verify

Existing logic forwards `ANTHROPIC_*` and adds `host.docker.internal`.
Two cleanups:

1. Always add `--add-host=host.docker.internal:host-gateway` regardless
   of whether `ANTHROPIC_BASE_URL` is set on the host shell. (We don't
   know at this point whether the in-container env will need it.)
2. Document in the comment that the three vars are the official
   Anthropic SDK names and what each enables.

### Tests

- `config.test.mjs`: 4 new tests for `pickAuthMode` covering each of
  the four modes. Inject a fake `credentialsPath` pointing at a
  temp file with controlled content.
- `config.test.mjs`: 1 test for `LLM_PROVIDER=cli` with `mode='none'`
  → throws at config-load time.
- `provider-cli.mjs`: stays untested by automated tests (best-effort
  per the existing spec; SDK requires a real CLI binary).
- Integration smoke (manual, documented): three `docker run` recipes
  in the README, one per auth mode.

### Failure surface

| Failure | Where surfaced |
|---|---|
| `LLM_PROVIDER=cli` but no auth | App refuses to start, stderr lists the three remedies |
| `~/.claude/.credentials.json` unreadable | Treated as `mount` mode unavailable, falls through to next mode |
| `ANTHROPIC_BASE_URL` points at unreachable host | Surfaces at first chat call as "LLM upstream failed" |
| Router returns wrong protocol | Surfaces at first chat call as "Claude CLI run failed" |

## Files changed

| File | Change |
|---|---|
| `app/server/llm/config.mjs` | Add `cliEffective` resolver + `pickAuthMode`. Reject `mode === 'none'` when provider=cli. |
| `app/server/llm/config.test.mjs` | +5 tests for auth-mode resolution and pre-flight rejection. |
| `app/server/llm/provider-cli.mjs` | Pass explicit `env` to `query()` so subprocess sees exactly the resolved values. Use `cliEffective.*` fields. |
| `run.sh` | Always add `--add-host`. Comment cleanup. |
| `.env.example` | Already mostly there; refine the cli-section block to list the three modes plus the Pro/Max-via-mount mode. |
| `README.md` | Three short auth recipes (api-key / oauth / router). Stay generic — no BMW name. |

## Out of scope (V1)

- Detecting an expired OAuth token in the mount. The CLI will surface
  it at runtime; we don't pre-validate.
- Detecting a stale `ANTHROPIC_BASE_URL` (e.g. router not running).
  First chat surfaces it as `LLM upstream failed`.
- Multi-provider fan-out, key rotation, telemetry. YAGNI.
