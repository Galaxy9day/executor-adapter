# pi-adapter

[![npm version](https://img.shields.io/npm/v/@galaxy9day/pi-adapter.svg)](https://www.npmjs.com/package/@galaxy9day/pi-adapter)
[![license](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets Claude Code / Codex / any MCP-aware orchestrator dispatch coding tasks to the **Pi coding agent** (`pi` CLI).

Acts as a **Trellis channel adapter** (parallel to the built-in `claude.ts` and `codex.ts` adapters) when [`trellis channel`](https://docs.trytrellis.app/) is active. Falls back to a standalone subprocess path with its own lock + auto-validation when invoked outside Trellis.

---

## What it does

- Reads Trellis task artifacts (`prd.md`, `design.md`, `implement.md`, `implement.jsonl` / `check.jsonl`) and assembles a Pi-ready prompt.
- Spawns Pi with sanitised environment (credential-shaped vars are stripped before inheritance).
- Defaults implementation/custom dispatches to an isolated git worktree under `.trellis/.runtime/pi-workers/<worker-id>/`, then exports `diff.patch` and `report.json` for the orchestrator to review/apply.
- Defaults check dispatches to read-only review mode (`read,grep,find,ls`) so Pi can supplement quality review without mutating the repo.
- In channel mode: emits bookend events into the Trellis channel via `@mindfoldhq/trellis-core`'s `sendMessage`, so the audit trail belongs to Trellis core.
- Runs post-execution validation against `git diff` (`min_files_changed`, `required_paths_modified`, `forbidden_paths`, `min_diff_lines`) — catches "exit 0 + no useful work" failures before the orchestrator sees them.
- Resolves Pi model names from `~/.pi/config.toml` so you never hard-code a model into your scripts.

## Install

### As an MCP server in Claude Code

```jsonc
// ~/.claude.json
{
  "mcpServers": {
    "pi-adapter": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@galaxy9day/pi-adapter@latest"]
    }
  }
}
```

That's it — `npx` fetches the latest version on each invocation; no `npm install` step needed.

### Globally (optional)

```bash
npm install -g @galaxy9day/pi-adapter
```

Then `"command": "pi-adapter"` in your MCP config (no args needed).

## Configure

`~/.pi/config.toml`:

```toml
[pi_adapter]
implementer = "newapi/gpt-5.5"           # used when mode=implement|custom
reviewer    = "anthropic/claude-opus-4-7" # used when mode=check / cross-model review
# Add any custom logical name you want, e.g.:
# fast        = "newapi/gpt-5-mini"
```

Without this config, calls without a fully-qualified `model` parameter throw a friendly error pointing you here.

You can also pass a fully-qualified Pi route directly per call:

```
dispatch(model="anthropic/claude-opus-4-7", ...)
```

## Tools

This server exposes 4 MCP tools (namespace `pi-adapter`):

### `dispatch(...)`

Assemble context, run Pi, optionally emit channel events, run post-validation, return result.

| Param | Type | Description |
|---|---|---|
| `mode` | `implement` \| `check` \| `custom` | Default `implement`. `custom` skips Trellis context assembly. |
| `task_dir` | string | Trellis task directory (relative to repo). Omit to auto-resolve via `task.py current`. |
| `working_directory` | string | Repo root; defaults to CWD. |
| `model` | string | Logical name (`implementer` / `reviewer` / custom key) or fully qualified route. |
| `thinking` | string | Pi thinking level. Default `high`. |
| `execution_mode` | string | `review`, `patch`, `worktree`, or `direct`. Defaults to `worktree` for `implement/custom`, `review` for `check`. |
| `isolate_pi` | boolean | Default `true`: disables Pi extensions/skills/prompt templates/context files/session persistence and uses a per-worker Pi home. |
| `tools` | string | Comma-separated tool list for Pi. Defaults by `execution_mode`: `review=read,grep,find,ls`, `patch=read,bash,grep,find,ls`, `worktree/direct=read,bash,edit,write,grep,find,ls`. |
| `timeout_minutes` | number | Default 60, hard-capped at 120. |
| `dry_run` | boolean | Build prompt without launching Pi. |
| `extra_instructions` | string | Additional prompt text appended after assembled context. |
| `scope` | string | File/path constraints communicated to Pi. |
| `validation_commands` | string[] | Commands Pi runs before reporting done. |
| `channel` | string | Trellis channel name. Overrides `TRELLIS_CHANNEL` / `TRELLIS_CHANNEL_NAME` env. |
| `min_files_changed` | number | Post-validation: fail if fewer files modified. |
| `required_paths_modified` | string[] | Post-validation: fail if any listed path NOT in diff. |
| `forbidden_paths` | string[] | Post-validation: fail if any listed path IS in diff (trailing `/` matches dir prefix). |
| `min_diff_lines` | number | Post-validation: fail if total ins+del < N. |

#### Execution modes

- `worktree` (default for implementation): creates `.trellis/.runtime/pi-workers/<worker-id>/repo` from `HEAD`, runs Pi there with an isolated `PI_CODING_AGENT_DIR`, writes `output.log`, `report.json`, and `diff.patch`, and returns an `apply_command` (`git apply "<patch>"`). The main repository is not modified by Pi.
- `review` (default for check): runs read-only with `read,grep,find,ls` and reports findings. Use this for cross-model review.
- `patch`: asks Pi to produce a unified diff in its final answer without direct edits.
- `direct`: legacy in-place execution in the target repository. Use only when the orchestrator explicitly wants Pi to write directly and the environment supports it.

`worktree` prompts embed Trellis manifest files and task artifacts so Pi can run from a clean checkout even when task files are uncommitted in the main worktree.

### `preview_prompt(...)`

Same args as `dispatch` (subset). Renders the prompt without launching Pi.

### `smoke({ model? })`

One-shot connectivity test. Verifies Pi binary is on PATH and the resolved model answers a trivial round-trip.

### `read_report({ log_file, lines? })`

Reads the tail of a Pi output log (produced by `dispatch`).

## Channel mode

When `dispatch` detects `TRELLIS_CHANNEL` / `TRELLIS_CHANNEL_NAME` env var (or an explicit `channel` arg), the adapter:

1. **Skips its own dispatch lock.** The channel's `worker_guard` owns liveness, idle reclaim, and the live-worker cap.
2. **Emits bookend events** via `@mindfoldhq/trellis-core/channel`'s `sendMessage`:
   - `pi:dispatch_start` when Pi spawns (tagged, with structured `meta`)
   - `pi:dispatch_done` / `pi:dispatch_failed` / `pi:spawn_error` on exit (with exit code, validation status, changed files)
3. **Three-tier fallback**: if `@mindfoldhq/trellis-core` is unavailable, falls back to `trellis channel send` CLI (async); if that's also missing, drops the event with a stderr note. Dispatch never blocks on channel emission.
4. **Local log still written** at `.trellis/.runtime/pi-<ts>-output.log` (or `/tmp/pi-adapter/...`) for debugging.

Per-message streaming of Pi output is **not** parsed into events — Pi's stdout isn't `stream-json`. The bookend events plus the local log are the audit trail.

## Standalone (no Trellis) mode

When `.trellis/` isn't present, the main orchestrator agent (Claude Code / Codex / whatever invokes the MCP) is in charge:

- The skill exposes its tools; the orchestrator decides when to call them
- `dispatch` requires `extra_instructions` in `custom` mode
- Runtime files go to `/tmp/pi-adapter/pi-workers/<worker-id>/` instead of `.trellis/.runtime/pi-workers/<worker-id>/`
- A fingerprint lock keyed on `(scope, extra_instructions)` prevents accidental concurrent identical dispatches

## Forward compatibility

Designed to keep working through Trellis version upgrades:

- `@mindfoldhq/trellis-core/channel` is loaded via dynamic `import()` in `try/catch` — a missing or breaking-changed package degrades to CLI fallback, not module-load failure.
- Two env var aliases (`TRELLIS_CHANNEL`, `TRELLIS_CHANNEL_NAME`) are checked, so a future Trellis rename keeps working.
- `[trellis_pi_adapter]` TOML section is read as a legacy alias for `[pi_adapter]` (with a one-shot stderr nudge to migrate).
- No hard-coded paths — runtime dir resolves per-OS via `os.tmpdir()`; binaries can be overridden via `PI_BINARY` / `TRELLIS_BINARY` env.

## Environment

The Pi subprocess receives a **scrubbed** environment. Stripped prefixes/suffixes:

```
TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, PRIVATE_KEY, API_KEY,
*_KEY, *_AUTH, *_BEARER, *_COOKIE,
ANTHROPIC_*, OPENAI_*, CLAUDE_*, CCG_*,
AWS_(ACCESS|SECRET)_*, GH_TOKEN, GITHUB_TOKEN, OP_*, DOCKER_PASS*
```

Preserved: `PI_*`, `NEWAPI_*` (so Pi authenticates with its own provider).

The metaResponse line `Env: scrubbed N sensitive vars` confirms scrubbing fired. If Pi reports auth errors, the credential probably lives under a different prefix.

## Verification protocol

Auto-validation catches obvious failures. The orchestrator should still:

1. Read Pi's structured report (file list, test output, leftover TODOs)
2. Run tests independently (don't trust Pi's `exit 0`)
3. Inspect `git diff`
4. Spot-check spec compliance against PRD acceptance criteria
5. Smoke test the actual feature end-to-end
6. Log decisions Pi made outside spec

See [the body of the SKILL.md](./SKILL.md) (when used with the matching [coworkers](https://github.com/Galaxy9day/coworkers) skill) for the full protocol.

## Compatibility

| | Minimum |
|---|---|
| Node | 20 |
| `pi` CLI | any recent version, on PATH |
| Trellis (for channel mode) | `0.6.0-beta.10+` |
| Trellis (for spec assembly) | any 0.5+ |

## License

[AGPL-3.0-only](./LICENSE). This package depends on [`@mindfoldhq/trellis-core`](https://www.npmjs.com/package/@mindfoldhq/trellis-core) which is AGPL-3.0; downstream users must follow the same license.

## Issues & contributions

[GitHub Issues](https://github.com/Galaxy9day/pi-adapter/issues) for bugs and feature requests.
