# executor-adapter

[![npm version](https://img.shields.io/npm/v/@galaxy9day/executor-adapter.svg)](https://www.npmjs.com/package/@galaxy9day/executor-adapter)
[![license](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets Claude Code / any MCP-aware orchestrator dispatch coding tasks to an executor backend: the **OpenAI Codex CLI** (`codex exec`) or the **Pi coding agent** (`pi` CLI).

When Trellis is present, this MCP reads Trellis task artifacts and can optionally emit **non-invasive Trellis channel audit messages**. It does **not** register as a native Trellis channel provider/worker. Outside Trellis, it falls back to a standalone subprocess path with its own lock + auto-validation.

Recommended: Trellis ≥ 0.6.0 (tested against 0.6.9). Channel audit messages require `@mindfoldhq/trellis-core` 0.6.x; without it the adapter degrades to the `trellis channel send` CLI, then drops the event. This MCP complements — never replaces — Trellis native channel workers or the built-in Pi extension.

---

## What it does

- Reads Trellis task artifacts (`prd.md`, `design.md`, `implement.md`, `implement.jsonl` / `check.jsonl`) and assembles an executor-ready prompt.
- Embeds Trellis context within a per-file (32 KiB) and total (128 KiB) budget mirroring Trellis 0.6.x sub-agent context caps; over-budget files are truncated to a leading summary and later files list their path only (`embed_context=false` skips inlining entirely).
- Defaults implementation/custom dispatches to **Codex CLI** in an isolated git worktree under `.trellis/.runtime/pi-workers/<worker-id>/`, then exports `diff.patch` and `report.json` for the orchestrator to review/apply.
- Keeps **Pi** available as an opt-in provider-routing backend for cross-model review or non-OpenAI implementation experiments.
- Spawns the selected executor with a sanitised environment (credential-shaped vars are stripped before inheritance).
- Reports a v2 orthogonal fact model (`ok` / `run_status` / `patch` / `post_validation`) so the orchestrator can route outcomes from structured fields instead of parsing executor prose; `ok` is the single success signal (`isError = !ok`).
- Defaults adapter `check` dispatches to read-only Pi review mode (`read,bash,grep,find,ls`) so Pi can supplement quality review without mutating the repo.
- In channel mode: emits best-effort bookend audit messages into the Trellis channel via `@mindfoldhq/trellis-core`'s `sendMessage`.
- Runs post-execution validation against `git diff` (`min_files_changed`, `required_paths_modified`, `forbidden_paths`, `min_diff_lines`) — catches "exit 0 + no useful work" failures before the orchestrator sees them. (Skipped in review mode.)
- Resolves executor model names from `~/.pi/config.toml` so you never hard-code provider routes into scripts.

## Install

### As an MCP server in Claude Code

```jsonc
// ~/.claude.json
{
  "mcpServers": {
    "executor-adapter": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@galaxy9day/executor-adapter@latest"]
    }
  }
}
```

That's it — `npx` fetches the latest version on each invocation; no `npm install` step needed.

### Globally (optional)

```bash
npm install -g @galaxy9day/executor-adapter
```

Then `"command": "executor-adapter"` in your MCP config (no args needed).

### Migration from `pi-adapter`

`executor-adapter` is the long-term package, binary, MCP server key, and skill
name. The old `@galaxy9day/pi-adapter` package can remain installed for
existing machines that still use the `pi-adapter` MCP server key, but new MCP
configs should use the `executor-adapter` server key so tool names are
`mcp__executor-adapter__dispatch`, `mcp__executor-adapter__smoke`, and so on.

For multi-device use, configure Codex independently on each machine. The Codex
executor reads that machine's `$CODEX_HOME/config.toml` and `$CODEX_HOME/auth.json`;
the adapter does not forward `OPENAI_API_KEY`, `CODEX_API_KEY`, or other API-key
environment variables into the subprocess.

## Configure

`~/.pi/config.toml`:

```toml
[executor_adapter]
implementer = "newapi/gpt-5.5"           # pi executor, mode=implement|custom
reviewer    = "anthropic/claude-opus-4-7" # pi executor, mode=check / cross-model review
# default_executor = "codex"             # optional: override the built-in routing for all calls
# Add any custom logical name you want, e.g.:
# fast        = "newapi/gpt-5-mini"

[executor_adapter.codex]
implementer = "gpt-5.5"                  # optional; omit the section to use the codex CLI default model
reviewer    = "gpt-5.5"
```

Without this config, pi-executor calls without a fully-qualified `model` parameter throw a friendly error pointing you here. The codex executor never requires config: with no `[executor_adapter.codex]` entry and no `model` parameter it omits `-m` and uses the codex CLI's own configured default model.

You can also pass a fully-qualified Pi route or exact Codex model id directly per call:

```
dispatch(model="anthropic/claude-opus-4-7", executor="pi", ...)
dispatch(executor="codex", ...)                  # use this machine's Codex default
dispatch(model="gpt-5.5", executor="codex", ...) # explicit Codex model id
```

Do not pass `model="codex"`: `codex` is the executor backend name, not a model.

## Executors

Two backends share the same dispatch pipeline (worktree isolation, diff export, post-validation, v2 report model, channel audit):

| | `pi` | `codex` |
|---|---|---|
| Binary | `pi` (`PI_BINARY` override) | `codex` (`CODEX_BINARY` override) |
| Model source | `[executor_adapter]` logical names or full route | `[executor_adapter.codex]`, explicit `model`, or the codex CLI default |
| Isolation (`isolate_executor=true`) | per-worker `PI_CODING_AGENT_DIR` + `--no-extensions/--no-skills/...` | `--ignore-rules --ephemeral`; user config is still loaded for provider/auth settings |
| Tool restriction | `--tools` list from the `tools` param | OS sandbox: `--sandbox read-only` (review) or `workspace-write` (worktree/direct) |
| Auth | `PI_*` / `NEWAPI_*` env preserved | local `$CODEX_HOME/config.toml` + `$CODEX_HOME/auth.json`; API keys are never forwarded |
| Output | plain text log | `--json` JSONL events; token `usage` lands in report.json |

Routing: explicit `executor` param > `default_executor` in `[executor_adapter]` > built-in default — **implement/custom → codex** (native GPT harness + OS sandbox), **check → pi** (cross-model review via Pi's provider routing). A missing binary is a hard error with a hint, never a silent fallback.

## Tools

This server exposes 5 MCP tools (namespace `executor-adapter`):

### `dispatch(...)`

Assemble context, run the selected executor, optionally emit channel events, run post-validation, return result.

| Param | Type | Description |
|---|---|---|
| `mode` | `implement` \| `check` \| `custom` | Default `implement`. `custom` skips Trellis context assembly. |
| `task_dir` | string | Trellis task directory (relative to repo). Omit to auto-resolve via `task.py current`. |
| `working_directory` | string | Repo root; defaults to CWD. |
| `executor` | `pi` \| `codex` | Executor backend. Defaults: `default_executor` config, else `implement/custom→codex`, `check→pi`. |
| `model` | string | Logical name (`implementer` / `reviewer` / custom key; `[executor_adapter.codex]` for codex) or fully qualified route/model name. For Codex, omit it to use `$CODEX_HOME/config.toml`; never use `model="codex"`. |
| `thinking` | string | Reasoning effort. Default `xhigh` (`--thinking` for pi, `model_reasoning_effort` for codex). |
| `execution_mode` | string | `review`, `worktree`, or `direct`. Defaults to `worktree` for `implement/custom`, `review` for `check`. |
| `isolate_executor` | boolean | Default `true`. Pi: disables extensions/skills/prompt templates/context files/session persistence and uses a per-worker Pi home. Codex: `--ignore-rules --ephemeral` while still loading user config for provider/auth settings. |
| `embed_context` | boolean | Default `true`: inline Trellis manifest/task artifact contents. When `false`, only list paths for the executor to read on demand. |
| `tools` | string | Comma-separated tool list (pi executor only; codex restricts via `--sandbox`). Defaults by `execution_mode`: `review=read,bash,grep,find,ls`, `worktree/direct=read,bash,edit,write,grep,find,ls`. |
| `timeout_minutes` | number | Default 60, hard-capped at 120. |
| `dry_run` | boolean | Build prompt without launching the executor. |
| `extra_instructions` | string | Additional prompt text appended after assembled context. |
| `scope` | string | File/path constraints communicated to the executor. |
| `context_files` | string[] | Optional extra files to embed in the prompt. Contents are included only when explicitly requested. |
| `trellis_context_id` | string | Optional Trellis session/context id. Passed as `TRELLIS_CONTEXT_ID` when auto-resolving the active task. |
| `validation_commands` | string[] | Commands the executor should run before reporting done. |
| `channel` | string | Trellis channel name. Overrides `TRELLIS_CHANNEL` / `TRELLIS_CHANNEL_NAME` env. |
| `min_files_changed` | number | Post-validation: fail if fewer files modified. |
| `required_paths_modified` | string[] | Post-validation: fail if any listed path NOT in diff. |
| `forbidden_paths` | string[] | Post-validation: fail if any listed path IS in diff (trailing `/` matches dir prefix). |
| `min_diff_lines` | number | Post-validation: fail if total ins+del < N. |
| `base` | string | Review-only: git ref diffed into the prompt. Defaults to `main`. The adapter runs `git diff --stat <base>` plus a truncated `git diff <base>` and embeds them under "Changes under review" so the reviewer need not guess the diff. Silently skipped when the ref is absent or the dir is not a git repo. |

#### Execution modes

- `worktree` (default for implementation): creates `.trellis/.runtime/pi-workers/<worker-id>/repo` from `HEAD`, runs the executor there, writes `output.log`, `report.json`, and `diff.patch`, and returns an `apply_command` (`git apply "<patch>"`) when the patch is non-empty. The main repository is not modified by the executor.
- `review` (default for check): runs read-only and reports findings. Codex uses `--sandbox read-only`; Pi uses `read,bash,grep,find,ls` (the prompt restricts bash to read-only use — no writes/staging/commits/push). The adapter also embeds `git diff <base>` into the prompt and copies the executor's verdict into `report.json` as `review_summary`. Use this for cross-model review.
- `direct`: legacy in-place execution in the target repository. Use only when the orchestrator explicitly wants executor writes in the main repo and the environment supports it.

`worktree` prompts embed Trellis manifest files and task artifacts so the executor can run from a clean checkout even when task files are uncommitted in the main worktree. If the assembled prompt exceeds 80 KB, Pi dispatches print a warning because very large prompts can destabilize Pi's isolated-mode SSE client. Use a curated `implement.jsonl` or `embed_context=false` when the executor can read the files directly from the worktree.

#### Report model (v2)

`report.json` and the MCP return use an orthogonal fact model. `ok` is the single success signal (`isError = !ok`); the other fields are independent facts:

```json
{
  "schema": "executor-adapter.report.v2",
  "ok": true,
  "run_status": "done",
  "execution_mode": "worktree",
  "project_mode": "trellis_local_worktree",
  "exit_code": 0,
  "signal": null,
  "usage": { "input_tokens": 120, "output_tokens": 30 },
  "patch": {
    "status": "ready",
    "file": "/path/to/diff.patch",
    "changed_files": ["src/feature.ts"],
    "error": null
  },
  "post_validation": {
    "status": "passed",
    "failures": [],
    "checks": ["min_files_changed", "required_paths_modified"]
  },
  "apply_command": "git apply \"/path/to/diff.patch\"",
  "requested_validation_commands": ["npm test"],
  "error": null,
  "worker_id": "codex-implement-...",
  "worker_repo": "/path/to/worktree/repo",
  "prompt_file": "...", "log_file": "...", "report_file": "...",
  "finished_at": "2026-07-25T..."
}
```

- **`run_status`**: `done` | `failed` | `timeout` | `killed` | `spawn_error` | `setup_failed`. Timeout (our kill) takes precedence over signal; `failed` covers non-zero exit **or** an executor-native structured failure (Codex `turn.failed` / `error` JSONL events) — the natural-language approval-scanning heuristic was removed.
- **`patch.status`**: `ready` (non-empty worktree patch) | `none` (no changes) | `export_failed` (diff export errored) | `not_applicable` (direct/review). Always present.
- **`post_validation.status`**: `passed` | `failed` | `skipped`. Review mode is always `skipped`, even when check params are supplied. `checks` lists the actually-configured check names.
- **`error`**: top-level structured `{ stage, message }`, present on every report (`null` when `ok=true`). Stages: `worktree_setup`, `spawn`, `timeout`, `killed`, `executor`, `post_validation`, `patch`, `patch_export`. `patch.error` is the source of truth for diff-export errors only.
- **`ok`** derivation: non-worktree `ok = run_status==='done' && post_validation.status!=='failed'`; worktree adds `&& patch.status==='ready'`. `isError = !ok`.

`apply_command` is non-null only for `worktree` + `patch.status==='ready'`. The dispatch response intentionally does not inline long stdout/stderr; use `read_report` for the log tail.

`project_mode` is one of `trellis_channel_bridge`, `trellis_local_worktree`, `standalone_worktree`, or `standalone`.

### `preview_prompt(...)`

Same args as `dispatch` (subset). Renders the prompt without launching an executor.

### `smoke({ model?, mode?, executor? })`

One-shot connectivity test. Verifies the executor binary is on PATH and the resolved model answers a trivial round-trip. `model` accepts either a logical name or a fully qualified route/model name, `mode` (`implement` or `check`) chooses the default logical key when `model` is omitted, and `executor` follows the same routing defaults as `dispatch`. For Codex, `model="codex"` is rejected for the same reason as `dispatch`. On failure it prints separate stdout and stderr blocks, the resolved model, safe env values, and (pi) the config files copied into the isolated Pi home.

### `read_report({ log_file?, report_file?, runtime_dir?, worker_id?, lines? })`

Reads `report.json` when available and prints a short summary first: `ok`, `run_status`, `patch.status`, `post_validation.status`, `project_mode`, `changed_files`, and `apply_command`. It can resolve both Trellis runtime directories (`.trellis/.runtime/pi-workers/<worker-id>/`) and standalone runtime directories (`/tmp/executor-adapter/pi-workers/<worker-id>/`), and any explicit `runtime_dir`/`report_file`/`log_file` path. Log tail output remains available via `lines`.

### `cleanup_runtime({ working_directory?, retain_days?, dry_run? })`

Prunes old `pi-*` / `codex-*` worker directories from the adapter runtime (`.trellis/.runtime/pi-workers/` in Trellis repos, `/tmp/executor-adapter/pi-workers/` otherwise). It reports removed/retained worker dirs and freed bytes. Use `dry_run=true` before deleting.

## Channel mode

When `dispatch` detects `TRELLIS_CHANNEL` / `TRELLIS_CHANNEL_NAME` env var (or an explicit `channel` arg), the adapter:

1. **Keeps its own local dispatch lock.** A channel message does not make the executor a native Trellis worker; Trellis `worker_guard` does not own this subprocess lifecycle.
2. **Emits bookend audit messages** via `@mindfoldhq/trellis-core/channel`'s `sendMessage`:
   - text `executor-adapter: dispatch_start` when the executor spawns
   - text `executor-adapter: dispatch_done` / `dispatch_failed` on exit; `setup_failed` / `spawn_error` for terminal pre-run failures
   - structured `meta` includes `schema: "executor-adapter.dispatch.v2"`, `event` (the bookend name — trellis-core 0.6.x dropped the `tag` option), and the core v2 facts: `ok`, `run_status`, the full `patch` and `post_validation` objects, `error`, exit code, report/log paths
   - a stable `idempotencyKey` (`executor-adapter:<worker_id>:<event>`) so retries don't double-append — trellis-core 0.6.x `appendEvent` dedups on `idempotencyKey` + `kind`
   - `task` is sent as a workDir-relative path (resolved from absolute / symlinked task dirs) so a channel reader on another checkout can locate it
3. **Three-tier fallback**: if `@mindfoldhq/trellis-core` is unavailable, falls back to official `trellis channel send --as executor-adapter --stdin` CLI shape (async); if that's also missing, drops the event with a stderr note. Dispatch never blocks on channel emission.
4. **Local log still written** at `.trellis/.runtime/pi-workers/<worker-id>/output.log` (or `/tmp/executor-adapter/...`) for debugging.

Codex `--json` events are parsed into the local report, but channel mode still emits only dispatch bookends for a stable Trellis audit surface. Pi stdout is plain text, so it is not streamed into per-message channel events. These audit messages are normal Trellis `message` events, not native `spawned` / `done` / `killed` worker lifecycle events. Read the MCP result, `report.json`, `output.log`, or use `read_report` for the authoritative result.

## Standalone (no Trellis) mode

When `.trellis/` isn't present, the main orchestrator agent (Claude Code / Codex / whatever invokes the MCP) is in charge:

- The skill exposes its tools; the orchestrator decides when to call them
- `dispatch` requires `extra_instructions` in `custom` mode
- Runtime files go to `/tmp/executor-adapter/pi-workers/<worker-id>/` instead of `.trellis/.runtime/pi-workers/<worker-id>/`
- A fingerprint lock keyed on `(scope, extra_instructions)` prevents accidental concurrent identical dispatches

## Trellis 0.6 custom agents and skills

Trellis 0.6.x has two extension points that matter here:

- **Custom sub-agents** (`.trellis/agents/*.md` for channel runtime, or platform-specific agent files such as `.claude/agents/*.md`) isolate a role/prompt and can be spawned by the orchestrator.
- **Custom skills** (`*/skills/<name>/SKILL.md`) are auto-triggered workflow modules. They are the right place for usage policy, but not a replacement for the MCP server itself.

`executor-adapter` remains an MCP server. It is not a native Trellis channel provider, and it does not install or mutate `.trellis/agents` files. Trellis native channel workers should continue to use `.trellis/agents/implement.md` / `check.md` or your own channel agents. Use the templates below when you want a Claude Code sub-agent to call the MCP and summarize the executor result, keeping long dispatch output out of the main context.

This package ships ready-to-copy Claude Code custom agent templates in `templates/claude/agents/`:

```bash
cp templates/claude/agents/*.md <your-project>/.claude/agents/
```

The templates are for Trellis projects that want executor dispatch to run inside a Claude Code sub-agent instead of the orchestrator's main session. The main session can spawn them with:

```text
Task(subagent_type="trellis-codex-implement")
Task(subagent_type="trellis-pi-implement")
Task(subagent_type="trellis-pi-check")
```

This keeps long dispatch output out of the main context. The sub-agent receives the MCP result, reads reports only when needed, and returns a short summary to the orchestrator.

Use `trellis-codex-implement` for the normal GPT implementation path. Use `trellis-pi-implement` only when you explicitly want Pi provider routing for implementation, and `trellis-pi-check` for read-only cross-model review. The templates set `effort: xhigh` for the Claude Code sub-agent itself; the MCP `thinking` parameter separately defaults to `xhigh` for the Codex/Pi executor it launches. The Codex template omits `model` so `codex exec` uses this machine's Codex default from `$CODEX_HOME/config.toml`; the Pi templates resolve logical routes from `~/.pi/config.toml`.

No Trellis `inject-subagent-context` hook edit is required. `dispatch` assembles Trellis task context itself from the task artifacts (`prd.md`, `design.md`, `implement.md`, `implement.jsonl`, and `check.jsonl` where applicable). For Codex/Pi/other platforms, translate these templates to the platform's native custom-agent syntax; do not put MCP tool names in `.trellis/agents/*.md`, because those files are provider-level channel runtime prompts, not MCP-capability declarations.

See the Trellis docs:

- Custom agents: https://docs.trytrellis.app/advanced/custom-agents
- Custom skills: https://docs.trytrellis.app/advanced/custom-skills

## Forward compatibility

Designed to keep working through Trellis version upgrades:

- `@mindfoldhq/trellis-core/channel` is loaded via dynamic `import()` in `try/catch` — a missing or breaking-changed package degrades to CLI fallback, not module-load failure.
- Two env var aliases (`TRELLIS_CHANNEL`, `TRELLIS_CHANNEL_NAME`) are checked, so a future Trellis rename keeps working.
- `[pi_adapter]` and `[trellis_pi_adapter]` TOML sections are **no longer read** (0.11.0 breaking change): discovery of a legacy section emits a `CONFIG ERROR` to stderr and the section is ignored. Rename to `[executor_adapter]`. (`read_report(runtime_dir)` still accepts any explicit directory path.)
- No hard-coded paths — runtime dir resolves per-OS via `os.tmpdir()`; binaries can be overridden via `PI_BINARY` / `CODEX_BINARY` env.

## Environment

Executor subprocesses receive a **scrubbed** environment. Stripped prefixes/suffixes:

```
TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, PRIVATE_KEY, API_KEY,
*_KEY, *_AUTH, *_BEARER, *_COOKIE,
ANTHROPIC_*, OPENAI_*, CLAUDE_*, CCG_*,
AWS_(ACCESS|SECRET)_*, GH_TOKEN, GITHUB_TOKEN, OP_*, DOCKER_PASS*
```

Preserved: `PI_*`, `NEWAPI_*` (so Pi authenticates with its own provider) for the pi executor; `CODEX_HOME` and `CODEX_SQLITE_HOME` for the codex executor. By default, each machine uses its own Codex provider/auth state from `$CODEX_HOME/config.toml` and `$CODEX_HOME/auth.json` (`codex login`). `CODEX_API_KEY`, `OPENAI_API_KEY`, and other API keys are not forwarded to executor subprocesses, which keeps multi-device setups local to each host instead of depending on a synchronized key.

The metaResponse line `Env: scrubbed N sensitive vars` confirms scrubbing fired. If an executor reports auth errors, the credential probably lives under a different prefix or the executor home does not contain the expected login state.

## Verification protocol

Auto-validation catches obvious failures. The orchestrator should still:

1. Dispatch Codex or Pi in `worktree` mode.
2. Inspect `report.json` and `diff.patch`.
3. Apply the patch if acceptable.
4. Run cheap validation.
5. Run sample/small validation.
6. Run independent check / `trellis-check`.
7. If the check modifies code, re-run sample/small validation.
8. Run expensive full validation.
9. Commit only from the orchestrator after validation passes.

Do not start expensive full validation before independent check work that may modify code; a check fix invalidates the full run.

For data-dependent worktree dispatches, pass stable schema or small sample artifacts through `context_files` when the executor needs facts that are not committed. Isolated worktrees do not include gitignored, generated, or uncommitted derived data.

The full dispatch/verification protocol is documented in the executor-adapter skill (see the [project repository](https://github.com/Galaxy9day/executor-adapter), used together with the matching [coworkers](https://github.com/Galaxy9day/coworkers) skill).

## Compatibility

| | Minimum |
|---|---|
| Node | 20 |
| `pi` CLI (pi executor) | any recent version, on PATH |
| `codex` CLI (codex executor) | any version with `codex exec --json` (2025+), on PATH, logged in via `codex login` |
| Trellis (for channel mode) | `0.6.0+` (`0.6.9` tested) |
| Trellis (for spec assembly) | any 0.5+ |

## License

[AGPL-3.0-only](./LICENSE). This package depends on [`@mindfoldhq/trellis-core`](https://www.npmjs.com/package/@mindfoldhq/trellis-core) which is AGPL-3.0; downstream users must follow the same license.

## Issues & contributions

[GitHub Issues](https://github.com/Galaxy9day/executor-adapter/issues) for bugs and feature requests.
