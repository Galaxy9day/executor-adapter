/**
 * v2 orthogonal report model for executor-adapter.
 *
 * Pure helpers extracted from index.js so the success/failure model can be
 * unit-tested without spawning the MCP server. The dispatcher (index.js)
 * computes the facts (run_status, raw validation, diffInfo, executor-native
 * error) and feeds them here; this module never performs I/O.
 *
 * Model:
 * - `ok` is the single success signal (isError = !ok).
 * - run_status / patch / post_validation are independent orthogonal facts.
 * - A top-level structured `error` describes why ok=false (stage + message);
 *   `patch.error` is the source of truth for diff-export errors only.
 */

export const REPORT_SCHEMA = 'executor-adapter.report.v2';

export const POST_VALIDATION_CHECKS = [
  'min_files_changed',
  'required_paths_modified',
  'forbidden_paths',
  'min_diff_lines',
];

export function configuredValidationChecks(params) {
  return POST_VALIDATION_CHECKS.filter((name) => {
    if (name === 'min_files_changed') return typeof params.min_files_changed === 'number';
    if (name === 'required_paths_modified') return Array.isArray(params.required_paths_modified) && params.required_paths_modified.length > 0;
    if (name === 'forbidden_paths') return Array.isArray(params.forbidden_paths) && params.forbidden_paths.length > 0;
    if (name === 'min_diff_lines') return typeof params.min_diff_lines === 'number';
    return false;
  });
}

export function buildPostValidation(executionMode, raw, params) {
  const checks = configuredValidationChecks(params);
  // review always skips post-validation, even when check params are supplied.
  if (executionMode === 'review') return { status: 'skipped', failures: [], checks };
  if (!raw || raw.skipped) return { status: 'skipped', failures: [], checks };
  return { status: raw.passed ? 'passed' : 'failed', failures: raw.failures || [], checks };
}

// patch.status: not_applicable (non-worktree) | none (no changes) |
// export_failed (diff export errored) | ready (non-empty patch).
export function buildPatch(executionMode, diffInfo, changedFiles, patchPath) {
  if (executionMode !== 'worktree') {
    return { status: 'not_applicable', file: null, changed_files: [], error: null };
  }
  if (!diffInfo || !diffInfo.ok) {
    return { status: 'export_failed', file: patchPath, changed_files: [], error: (diffInfo && diffInfo.error) || 'diff export failed' };
  }
  const changed = Array.isArray(changedFiles) ? changedFiles : [];
  if (changed.length === 0) return { status: 'none', file: patchPath, changed_files: [], error: null };
  return { status: 'ready', file: patchPath, changed_files: changed, error: null };
}

// ok: single source of truth for success. isError = !ok. Orthogonal facts only.
// - non-worktree: ok = run_status==='done' && post_validation.status!=='failed'
// - worktree:     ok = above && patch.status==='ready'
export function computeOk(runStatus, patch, postValidation) {
  if (runStatus !== 'done') return false;
  if (postValidation.status === 'failed') return false;
  if (patch.status === 'none' || patch.status === 'export_failed') return false;
  return true;
}

// run_status precedence (v2.1): our timeout kill → timeout; other signal →
// killed; otherwise the interpreter's done/failed (exit code + executor-native
// structured failure). Extracted so the precedence is unit-testable.
export function resolveRunStatus({ killed, signaled, interpRunStatus }) {
  if (killed) return 'timeout';
  if (signaled) return 'killed';
  return interpRunStatus;
}

// Top-level structured error for every ok=false outcome. patch.error remains
// the source of truth for diff-export errors specifically.
export function buildDispatchError({ runStatus, patch, postValidation, interpError, exitCode, signal, timeoutMinutes }) {
  if (runStatus === 'timeout') return { stage: 'timeout', message: `Executor exceeded ${timeoutMinutes} minute timeout` };
  if (runStatus === 'killed') return { stage: 'killed', message: `Process exited by signal${signal ? ` ${signal}` : ''}` };
  if (runStatus === 'failed') return { stage: 'executor', message: interpError || `Executor exited with code ${exitCode}` };
  if (runStatus === 'done') {
    if (postValidation.status === 'failed') return { stage: 'post_validation', message: 'Post-validation checks failed' };
    if (patch.status === 'export_failed') return { stage: 'patch_export', message: patch.error || 'diff export failed' };
    if (patch.status === 'none') return { stage: 'patch', message: 'No changes produced in worktree' };
  }
  return null;
}
