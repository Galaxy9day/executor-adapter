# pi-adapter

[![npm version](https://img.shields.io/npm/v/@galaxy9day/pi-adapter.svg)](https://www.npmjs.com/package/@galaxy9day/pi-adapter)
[![license](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](./LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets Claude Code / any MCP-aware orchestrator dispatch coding tasks to an executor backend: the **OpenAI Codex CLI** (`codex exec`) or the **Pi coding agent** (`pi` CLI).

When Trellis is present, this MCP reads Trellis task artifacts and can optionally emit **non-invasive Trellis channel audit messages**. It does **not** register as a native Trellis channel provider/worker. Outside Trellis, it falls back to a standalone subprocess path with its own lock + auto-validation.

---

## What it does

- Reads Trellis task artifacts (`prd.md`, `design.md`, `implement.md`, `implement.jsonl` / `check.jsonl`) and assembles an executor-ready prompt.
- Defaults implementation/custom dispatches to **Codex CLI** in an isolated git worktree under `.trellis/.runtime/pi-workers/<worker-id>/`, then exports `diff.patch` and `report.json` for the orchestrator to review/apply.
- Keeps **Pi** available as an opt-in provider-routing backend for cross-model review or non-OpenAI implementation experiments.
- Spawns the selected executor with a sanitised environment (credential-shaped vars are stripped before inheritance).
- Classifies patch-ready limited-validation runs distinctly from true blockers, so orchestrators can continue main-repo validation without reading the full executor log.
- Defaults adapter `check` dispatches to read-only Pi review mode (`read,grep,find,ls`) so Pi can supplement quality review without mutating the repo.
- In channel mode: emits best-effort bookend audit messages into the Trellis channel via `@mindfoldhq/trellis-core`'s `sendMessage`.
- Runs post-execution validation against `git diff` (`min_files_changed`, `required_paths_modified`, `forbidden_paths`, `min_diff_lines`) — catches "exit 0 + no useful work" failures before the orchestrator sees them.
- Resolves executor model names from `~/.pi/config.toml` so you never hard-code provider routes into scripts.

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
implementer = "newapi/gpt-5.5"           # pi executor, mode=implement|custom
reviewer    = "anthropic/claude-opus-4-7" # pi executor, mode=check / cross-model review
# default_executor = "codex"             # optional: override the built-in routing for all calls
# Add any custom logical name you want, e.g.:
# fast        = "newapi/gpt-5-mini"

[pi_adapter.codex]
implementer = "gpt-5.5-codex"            # optional; omit the section to use the codex CLI default model
reviewer    = "gpt-5.5"
```

Without this config, pi-executor calls without a fully-qualified `model` parameter throw a friendly error pointing you here. The codex executor never requires config: with no `[pi_adapter.codex]` entry and no `model` parameter it omits `-m` and uses the codex CLI's own configured default model.

You can also pass a fully-qualified Pi route (or codex model name) directly per call:

```
dispatch(model="anthropic/claude-opus-4-7", executor="pi", ...)
dispatch(model="gpt-5.5-codex", executor="codex", ...)
```

## Executors

Two backends share the same dispatch pipeline (worktree isolation, diff export, post-validation, result classes, channel audit):

| | `pi` | `codex` |
|---|---|---|
| Binary | `pi` (`PI_BINARY` override) | `codex` (`CODEX_BINARY` override) |
| Model source | `[pi_adapter]` logical names or full route | `[pi_adapter.codex]`, explicit `model`, or the codex CLI default |
| Isolation (`isolate_executor=true`) | per-worker `PI_CODING_AGENT_DIR` + `--no-extensions/--no-skills/...` | `--ignore-user-config --ignore-rules --ephemeral` |
| Tool restriction | `--tools` list from the `tools` param | OS sandbox: `--sandbox read-only` (review/patch) or `workspace-write` (worktree/direct) |
| Auth | `PI_*` / `NEWAPI_*` env preserved | `~/.codex/auth.json` (run `codex login` once); API keys are never forwarded |
| Output | plain text log | `--json` JSONL events; token `usage` lands in report.json |

Routing: explicit `executor` param > `default_executor` in `[pi_adapter]` > built-in default — **implement/custom → codex** (native GPT harness + OS sandbox), **check → pi** (cross-model review via Pi's provider routing). A missing binary is a hard error with a hint, never a silent fallback.

## Tools

This server exposes 5 MCP tools (namespace `pi-adapter`):

### `dispatch(...)`

Assemble context, run the selected executor, optionally emit channel events, run post-validation, return result.

| Param | Type | Description |
|---|---|---|
| `mode` | `implement` \| `check` \| `custom` | Default `implement`. `custom` skips Trellis context assembly. |
| `task_dir` | string | Trellis task directory (relative to repo). Omit to auto-resolve via `task.py current`. |
| `working_directory` | string | Repo root; defaults to CWD. |
| `executor` | `pi` \| `codex` | Executor backend. Defaults: `default_executor` config, else `implement/custom→codex`, `check→pi`. |
| `model` | string | Logical name (`implementer` / `reviewer` / custom key; `[pi_adapter.codex]` for codex) or fully qualified route/model name. |
| `thinking` | string | Reasoning effort. Default `high` (`--thinking` for pi, `model_reasoning_effort` for codex). |
| `execution_mode` | string | `review`, `patch`, `worktree`, or `direct`. Defaults to `worktree` for `implement/custom`, `review` for `check`. |
| `isolate_executor` / `isolate_pi` | boolean | Default `true`. `isolate_executor` is the preferred name; `isolate_pi` remains as a compatibility alias. Pi: disables extensions/skills/prompt templates/context files/session persistence and uses a per-worker Pi home. Codex: `--ignore-user-config --ignore-rules --ephemeral`. |
| `embed_context` | boolean | Default `true`: inline Trellis manifest/task artifact contents. When `false`, only list paths for the executor to read on demand. |
| `tools` | string | Comma-separated tool list (pi executor only; codex restricts via `--sandbox`). Defaults by `execution_mode`: `review=read,grep,find,ls`, `patch=read,bash,grep,find,ls`, `worktree/direct=read,bash,edit,write,grep,find,ls`. |
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

#### Execution modes

- `worktree` (default for implementation): creates `.trellis/.runtime/pi-workers/<worker-id>/repo` from `HEAD`, runs the executor there, writes `output.log`, `report.json`, and `diff.patch`, and returns an `apply_command` (`git apply "<patch>"`). The main repository is not modified by the executor.
- `review` (default for check): runs read-only and reports findings. Codex uses `--sandbox read-only`; Pi uses `read,grep,find,ls`. Use this for cross-model review.
- `patch`: asks the executor to produce a unified diff in its final answer without direct edits.
- `direct`: legacy in-place execution in the target repository. Use only when the orchestrator explicitly wants executor writes in the main repo and the environment supports it.

`worktree` prompts embed Trellis manifest files and task artifacts so the executor can run from a clean checkout even when task files are uncommitted in the main worktree. If the assembled prompt exceeds 80 KB, Pi dispatches print a warning because very large prompts can destabilize Pi's isolated-mode SSE client. Use a curated `implement.jsonl` or `embed_context=false` when the executor can read the files directly from the worktree.

#### Result classes and report fields

`report.json` and the MCP return include short structured fields for the orchestrator:

```json
{
  "status": "patch_ready_limited_validation",
  "result_class": "patch_ready_limited_validation",
  "status_reason": "The executor produced a non-empty patch and static/auto validation passed, but data validation was not available in the isolated worktree.",
  "validation_scope": "static/auto validation passed; data validation must run in main repo",
  "data_validation": "not_attempted",
  "data_validation_reason": "Derived/generated data was unavailable in the isolated worker; run data validation in the main repository after applying the patch.",
  "project_mode": "trellis_local_worktree",
  "apply_command": "git apply \"/path/to/diff.patch\"",
  "orchestrator_next_steps": [
    "Inspect report.json and diff.patch",
    "Apply patch: git apply \"/path/to/diff.patch\"",
    "Run cheap validation",
    "Run sample/small validation",
    "Run independent check/trellis-check",
    "If check changes code, re-run sample/small validation",
    "Run expensive full validation",
    "Commit only from the orchestrator after validation passes"
  ],
  "recommended_main_repo_commands": [
    "git apply \"/path/to/diff.patch\"",
    "git status --short",
    "git diff --stat"
  ]
}
```

`blocked` is reserved for runs where the executor cannot continue and no apply-ready patch is available. When the executor exits 0 with a non-empty patch and post-validation passes, but isolated worktree data validation is unavailable, the adapter returns `patch_ready_limited_validation` instead of `blocked`.

The dispatch response intentionally does not inline long stdout/stderr. It returns summary fields and artifact paths; use `read_report` when you need the log tail.

`project_mode` is one of `trellis_channel_bridge`, `trellis_local_worktree`, `standalone_worktree`, or `standalone`.

### `preview_prompt(...)`

Same args as `dispatch` (subset). Renders the prompt without launching an executor.

### `smoke({ model?, mode?, executor? })`

One-shot connectivity test. Verifies the executor binary is on PATH and the resolved model answers a trivial round-trip. `model` accepts either a logical name or a fully qualified route/model name, `mode` (`implement` or `check`) chooses the default logical key when `model` is omitted, and `executor` follows the same routing defaults as `dispatch`. On failure it prints separate stdout and stderr blocks, the resolved model, safe env values, and (pi) the config files copied into the isolated Pi home.

### `read_report({ log_file?, report_file?, runtime_dir?, worker_id?, lines? })`

Reads `report.json` when available and prints a short summary first: `result_class`, `project_mode`, `changed_files`, `apply_command`, next steps, and recommended commands. It can resolve both Trellis runtime directories (`.trellis/.runtime/pi-workers/<worker-id>/`) and standalone runtime directories (`/tmp/pi-adapter/pi-workers/<worker-id>/`). Log tail output remains available via `lines`.

### `cleanup_runtime({ working_directory?, retain_days?, dry_run? })`

Prunes old `pi-*` / `codex-*` worker directories from the adapter runtime (`.trellis/.runtime/pi-workers/` in Trellis repos, `/tmp/pi-adapter/pi-workers/` otherwise). It reports removed/retained worker dirs and freed bytes. Use `dry_run=true` before deleting.

## Channel mode

When `dispatch` detects `TRELLIS_CHANNEL` / `TRELLIS_CHANNEL_NAME` env var (or an explicit `channel` arg), the adapter:

1. **Keeps its own local dispatch lock.** A channel message does not make the executor a native Trellis worker; Trellis `worker_guard` does not own this subprocess lifecycle.
2. **Emits bookend audit messages** via `@mindfoldhq/trellis-core/channel`'s `sendMessage`:
   - text `pi-adapter: dispatch_start` when Pi spawns
   - text `pi-adapter: dispatch_done` / `dispatch_failed` / `spawn_error` on exit
   - structured `meta` includes `schema: "pi-adapter.dispatch.v1"`, exit code, validation status, changed files, report/log/patch paths
3. **Three-tier fallback**: if `@mindfoldhq/trellis-core` is unavailable, falls back to official `trellis channel send --as pi-adapter --stdin` CLI shape (async); if that's also missing, drops the event with a stderr note. Dispatch never blocks on channel emission.
4. **Local log still written** at `.trellis/.runtime/pi-workers/<worker-id>/output.log` (or `/tmp/pi-adapter/...`) for debugging.

Codex `--json` events are parsed into the local report, but channel mode still emits only dispatch bookends for a stable Trellis audit surface. Pi stdout is plain text, so it is not streamed into per-message channel events. These audit messages are normal Trellis `message` events, not native `spawned` / `done` / `killed` worker lifecycle events. Read the MCP result, `report.json`, `output.log`, or use `read_report` for the authoritative result.

## Standalone (no Trellis) mode

When `.trellis/` isn't present, the main orchestrator agent (Claude Code / Codex / whatever invokes the MCP) is in charge:

- The skill exposes its tools; the orchestrator decides when to call them
- `dispatch` requires `extra_instructions` in `custom` mode
- Runtime files go to `/tmp/pi-adapter/pi-workers/<worker-id>/` instead of `.trellis/.runtime/pi-workers/<worker-id>/`
- A fingerprint lock keyed on `(scope, extra_instructions)` prevents accidental concurrent identical dispatches

## Trellis sub-agent templates

This package ships ready-to-copy Claude Code / Trellis custom agent templates in `templates/claude/agents/`:

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

Use `trellis-codex-implement` for the normal GPT implementation path. Use `trellis-pi-implement` only when you explicitly want Pi provider routing for implementation, and `trellis-pi-check` for read-only cross-model review. The templates omit `model`, so the sub-agent inherits the Claude Code session model.

No Trellis `inject-subagent-context` hook edit is required. `dispatch` assembles Trellis task context itself from the task artifacts (`prd.md`, `design.md`, `implement.md`, `implement.jsonl`, and `check.jsonl` where applicable).

See the Trellis custom agents docs: https://docs.trytrellis.app/advanced/custom-agents

These files follow the Claude Code agent format. Users on other platforms (Cursor, OpenCode, Codex, or similar) should translate the frontmatter and tool declarations to their platform's native agent syntax.

## Forward compatibility

Designed to keep working through Trellis version upgrades:

- `@mindfoldhq/trellis-core/channel` is loaded via dynamic `import()` in `try/catch` — a missing or breaking-changed package degrades to CLI fallback, not module-load failure.
- Two env var aliases (`TRELLIS_CHANNEL`, `TRELLIS_CHANNEL_NAME`) are checked, so a future Trellis rename keeps working.
- `[trellis_pi_adapter]` TOML section is read as a legacy alias for `[pi_adapter]` (with a one-shot stderr nudge to migrate).
- No hard-coded paths — runtime dir resolves per-OS via `os.tmpdir()`; binaries can be overridden via `PI_BINARY` / `CODEX_BINARY` env.

## Environment

Executor subprocesses receive a **scrubbed** environment. Stripped prefixes/suffixes:

```
TOKEN, SECRET, PASSWORD, PASSWD, CREDENTIAL, PRIVATE_KEY, API_KEY,
*_KEY, *_AUTH, *_BEARER, *_COOKIE,
ANTHROPIC_*, OPENAI_*, CLAUDE_*, CCG_*,
AWS_(ACCESS|SECRET)_*, GH_TOKEN, GITHUB_TOKEN, OP_*, DOCKER_PASS*
```

Preserved: `PI_*`, `NEWAPI_*` (so Pi authenticates with its own provider) for the pi executor; `CODEX_HOME` and `CODEX_SQLITE_HOME` for the codex executor. Codex normally authenticates from `~/.codex/auth.json` (`codex login`). `CODEX_API_KEY`, `OPENAI_API_KEY`, and other API keys are not forwarded to executor subprocesses.

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

The full dispatch/verification protocol is documented in the pi-adapter skill (see the [project repository](https://github.com/Galaxy9day/pi-adapter), used together with the matching [coworkers](https://github.com/Galaxy9day/coworkers) skill).

## Compatibility

| | Minimum |
|---|---|
| Node | 20 |
| `pi` CLI (pi executor) | any recent version, on PATH |
| `codex` CLI (codex executor) | any version with `codex exec --json` (2025+), on PATH, logged in via `codex login` |
| Trellis (for channel mode) | `0.6.0-beta.10+` |
| Trellis (for spec assembly) | any 0.5+ |

## License

[AGPL-3.0-only](./LICENSE). This package depends on [`@mindfoldhq/trellis-core`](https://www.npmjs.com/package/@mindfoldhq/trellis-core) which is AGPL-3.0; downstream users must follow the same license.

## Issues & contributions

[GitHub Issues](https://github.com/Galaxy9day/pi-adapter/issues) for bugs and feature requests.
