# executor-adapter 0.11.0「大道至简」重构提案 v2

已吸收 codex（gpt-5.6）第一轮 review 的反提案。本轮请 codex 确认 v2 是否解决所有 DISAGREE/PARTIAL。

## v1 → v2 关键变更（采纳 codex 反提案）

- **C3**：从"收敛 result_class 到 6 种" → **彻底删 result_class，改正交事实模型**（ok/run_status/patch/post_validation）。
- **C5**：从"head/tail 改 tail-only" → **保留 head+tail**（启动期错误在开头，tail-only 丢诊断）。
- 新增砍除：`approvalBlocked`（正则扫自然语言）、`patch` execution_mode（半成品）、`isolate_pi` 兼容别名。
- 新增 bug 修复：review 当前仍跑 post-validation、worktree 创建失败误标 spawn_error、`isError` 靠状态白名单。
- C1：validation 改名 `post_validation` + `checks` 字段。
- C4：旧 config section 报 migration error；`read_report(runtime_dir)` 显式接受仍保留；channel schema v1→v2。
- §5：拆分用 `prepared`(不可变) + `outcome` 双对象，而非变异 ctx。
- 执行分两阶段：阶段1 纯结构（行为不变）→ 阶段2 v2 schema breaking。

## 目标：report v2 正交事实模型

```jsonc
{
  "schema": "executor-adapter.report.v2",
  "ok": true,                          // = isError 取反，唯一成功判据
  "run_status": "done",                // done|failed|timeout|killed|spawn_error|setup_failed
  "execution_mode": "worktree",        // worktree|direct|review（删 patch）
  "executor": "codex",
  "model": "gpt-5.6",
  "exit_code": 0,
  "signal": null,
  "killed": false,
  "patch": {                           // 仅 worktree
    "status": "ready",                 // ready|none|export_failed|not_applicable
    "has_patch": true,
    "file": "/path/to/diff.patch",
    "changed_files": ["..."],
    "error": null
  },
  "post_validation": {                 // review 模式 → skipped
    "status": "passed",                // passed|failed|skipped
    "failures": [],
    "checks": ["min_files_changed","required_paths_modified","forbidden_paths","min_diff_lines"]
  },
  "review_summary": "...",             // 仅 review 模式（tail-only）
  "apply_command": "git apply \"...\"",// 仅 worktree（事实，非推荐）
  "requested_validation_commands": [], // 审计：调用方传入的 validation_commands
  "worker_id": "...",
  "prompt_file": "...", "log_file": "...", "report_file": "...", "patch_file": "...",
  "finished_at": "..."
}
```

`ok` 统一驱动 `isError`（不再靠状态字符串白名单）。

## run_status 判定（删 approvalBlocked）

- exit 0 & !killed → `done`
- 超时 kill → `timeout`；其他 signal → `killed`
- 非 0 exit → `failed`
- spawn 失败 → `spawn_error`
- worktree 创建失败 → `setup_failed`（不再混进 spawn_error）

不再用正则扫 executor 自然语言判 blocked。

## 砍除清单（breaking，0.11.0）

1. data validation 状态机：`detectsDataValidationUnavailable`、`patch_ready_limited_validation`、`data_validation`/`data_validation_reason`/`validation_scope`/`validationScopeText` → `post_validation.{status,failures,checks}`。
2. `buildOrchestratorNextSteps`、`buildRecommendedCommands` 及 report 字段（保留 `apply_command` + `requested_validation_commands`）。
3. `result_class` 整个枚举 → 正交事实字段。
4. `approvalBlocked`（executors.js:135）+ 两处 interpretOutput 调用 → run_status done/failed。
5. `patch` execution_mode（半成品，无结构化 diff 提取；四模式→三模式）。
6. `isolate_pi` 兼容别名（参数 + report 字段）。
7. legacy 自动兼容：`LEGACY_SERVER_NAMES`、`legacyRuntimeDirs` 自动搜 `/tmp/pi-adapter`、`[pi_adapter]`/`[trellis_pi_adapter]` section 解析、`legacy_schema`。旧 config section 发现时报 **migration error**（不静默）；channel schema v1→**v2**。
   - **保留**：`CODEX_BACKEND_ALIASES` 的 `pi-adapter`（用于拒绝把后端名当 model，非运行时兼容，executors.js:103）；`read_report(runtime_dir)` 显式传入任意目录仍接受（index.js:1638）。
8. `snapshot`/`finalize` 双接口收敛为单一 `snapshot`（保留 head+tail）。

## 保留（核心，不动）

- `dispatch` + `EXECUTORS{pi,codex}` + `resolveExecutor` + model 路由（含 gpt-5.6 直传）。
- `execution_mode`：worktree/direct/review + `codexSandbox` + `defaultToolsForExecution`。
- worktree 链：`createWorktree`/`prepareWorkerDiff`/`diff.patch`/`apply_command`/`hasUsablePatch`。
- env scrub：`scrubEnv`/`SENSITIVE`/各 executor `buildEnv`。
- 四项 post-validation 规则（仅 worktree/direct 生效，**review → skipped**）。
- review 路径：`review_summary` + `captureReviewDiff` + `base` + review 跳过 post-validation。
- Trellis 读取：`assembleTrellisContext`/`readJsonlManifest`/`resolveActiveTask`/`fencedContentBudgeted`。
- channel 审计：`emitChannelEvent`（idempotencyKey+meta.event+相对 task）+ 三级降级。
- `makeHeadTailBuffer` head+tail（保留）+ `formatTinyLogDiagnostics` + executor `failureHint` + `promptSizeWarning` + `detectProjectMode`。
- `smoke`/`preview_prompt`/`read_report`/`cleanup_runtime` + dispatch lock + `trackChild` + `shutdownWithChildren`。

## 结构重构（两阶段）

**阶段 1（纯结构，行为不变，测试保持绿）**
- `dispatch` 454 行 → `prepareDispatch(args)`（解析/路由/worker/prompt，返回不可变 `prepared`）/ `runExecutor(prepared)`（lock+worktree+spawn+timeout+资源释放，单一 `finally` 收口，返回 `outcome`）/ `finalizeDispatch(prepared, outcome)`（diff/post-validation/report/channel）。
- `buildReportBase(prepared)` 只放稳定公共字段（worker_id/executor/model/paths/finished_at），不放 status/patch/validation。
- 砍 `makeHeadTailBuffer` 的 `finalize` 别名（保留 `snapshot`）。

**阶段 2（v2 schema breaking）**
- 实施砍除清单 1–7。
- report 改正交模型；`ok` 统一 isError。
- `SERVER_VERSION` → 0.11.0 + `package.json` + lockfile 同步。
- 更新 `read_report` summary、channel payload schema、TOOL schema、README、测试。

## codex 发现的 bug（随阶段 2 修）

- review 模式当前仍调 `runPostValidation`（index.js:1360）→ 改 `skipped`。
- worktree 创建失败当前标 `spawn_error`（index.js:1262）→ `setup_failed`。
- `isError` 当前靠 `['done','patch_ready_limited_validation']` 白名单（index.js:1487）→ `ok` 统一。

## codex 第二轮确认问题

1. v2 正交模型（`ok`/`run_status`/`patch`/`post_validation`）是否完整覆盖所有原有场景（含 timeout/killed/setup_failed/export_failed）？
2. 砍 `patch` 模式 + 砍 `approvalBlocked`，你确认 AGREE？
3. `dirSizeBytes`：我倾向**保留**（`cleanup_runtime` 的 `bytes_freed` 对用户有用），你坚持砍吗？
4. 两阶段顺序（阶段1 纯结构 → 阶段2 schema breaking）你 AGREE？
5. 还有遗漏或该留的我列错了吗？

输出：GO / GO-WITH-CHANGES / NO-GO + 逐题作答。只读，不写代码。

---

# v2.1 实施约束（codex 第二轮 GO-WITH-CHANGES，执行时强制遵守）

方向已两轮确认。以下是执行护栏。

## `ok` 单向定义（非循环）

- 非 worktree：`ok = run_status === 'done' && post_validation.status !== 'failed'`
- worktree：`ok = 上述 && patch.status === 'ready'`
- `isError = !ok`（单向，不要写 `ok = !isError`）

## `run_status` 判定顺序

- **timeout 优先于 signal**（修当前 `index.js:1371` 的覆盖 bug：超时发 SIGTERM 后被误标 killed）。
- `failed` = 非零 exit **OR** executor-native 结构化失败（codex `turn.failed`/`error` event，`executors.js:308/326`）。砍的是自然语言 `approvalBlocked`，**不是** executor-native failure 识别。

## `patch` 字段三模式始终存在

- direct/review → `not_applicable`
- worktree 无变更 → `none`
- worktree 导出失败 → `export_failed`
- worktree 有变更 → `ready`

## 资源生命周期（阶段 1 强制）

- lock 由**顶层 dispatch** 持有，`try/finally` 覆盖 `runExecutor + finalizeDispatch`；**不在** `runExecutor` 返回时释放（finalize 还在做 diff/report/channel）。
- worktree **不在** `runExecutor` 的 `finally` 清理（`finalizeDispatch` 要导出 patch）。
- timeout/killed 后仍尝试导出 patch + 跑适用 post-validation（事实独立记录，`ok=false`）。
- `setup_failed`/`spawn_error` 报告也含完整 v2 字段 + 顶层结构化 `error`。

## 字段精简

- 删顶层 `patch_file`（= `patch.file`，重复真值源）。
- `patch.has_patch` 由 `patch.status === 'ready'` 推导（删）。
- `killed` 由 `run_status` + `signal` 推导（删；语义易混淆）。
- 加顶层 `error`（覆盖 `setup_failed`/`spawn_error`/executor-native failure）；`patch.error` 只管导出错误。

## 必须保留的审计字段（v2 示例已补齐）

`usage`、`project_mode`、`task`、`model_source`、`model_key`、`tools`、`isolate_executor`、`worker_repo`（测试验证 `usage`/`project_mode`）。

## `post_validation.checks`

- 定义为实际配置的检查名；无检查 → `[]`/`skipped`。
- review 即使传入检查参数也必须 `skipped`。

## templates 同步（阶段 2）

`templates/claude/agents/*.md` 仍依赖 `result_class`/`status_reason`/`changed_files`，阶段 2 一并更新。

## channel v2

所有 worker 终态（含 `setup_failed`/`spawn_error`）都发事件，携带与 report 一致的 `ok`/`run_status`/`patch`/`post_validation` 核心事实。

## 测试矩阵（9 条，阶段 2 补齐）

1. exit 0 + codex `turn.failed` → `run_status=failed`、`ok=false`
2. timeout + SIGTERM → `run_status=timeout`（不能变 killed）
3. 外部 signal → `run_status=killed`
4. worktree setup 失败 → `setup_failed`
5. worktree patch 导出失败 → `run_status` 保留执行结果、`patch.status=export_failed`、`ok=false`
6. review + validation 参数 → `post_validation.status=skipped`
7. worktree 无变更 → `patch.status=none`、`ok=false`
8. direct 无检查 → `patch.status=not_applicable`、`post_validation.status=skipped`、`ok=true`
9. 所有 report 路径含 `schema`、`ok`、结构化 `error`；`isError === !report.ok`
