/**
 * Total erasure: the operator's way to make an agent as if it had never
 * existed.
 *
 * This is the one operation in the harness that destroys history, and it is
 * deliberately the only one. Death is the hard lock and everything else is
 * append-only, but a test agent someone made by accident must be removable, or
 * the roster fills with names nobody can reuse. So the rule this file follows
 * is: erase the agent, never the operator's own record.
 *
 * What goes, in this order:
 *  1. The running process, stopped first, so nothing writes a last row while
 *     the ledger is being cleared.
 *  2. Every ledger row that names the agent — its body, its history, its
 *     interventions, its death certificate — through `Ledger.eraseAgent`.
 *  3. Its home directory (`AGENTS/<name>/`: MEMORY, notebook, MODEL.json, any
 *     death certificate) and its black box directory.
 *
 * What stays:
 *  - The operator's audit line, filed under the conservatory rather than under
 *    this name, so the operator can still see they erased something.
 *  - Tasks the operator posted. Only the erased agent's hold on them is
 *    cleared, so a task still on the board is not deleted with the claimant.
 *
 * The order matters: stopping the process and clearing the ledger both precede
 * the filesystem removal, so a failure part-way leaves an agent that is already
 * gone from the ledger rather than a half-deleted home. A filesystem failure
 * after the ledger is cleared is reported, not swallowed — the row is gone, and
 * the operator has to be told the files are still on disk.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { agentHomeDir, type RuntimePaths } from '../config';
import { AGENT_NAME_PATTERN } from './population';
import type { Blackbox } from './blackbox';
import type { ErasedRows, Ledger } from './ledger';

export interface EraseDeps {
  ledger: Ledger;
  blackbox: Blackbox;
  paths: RuntimePaths;
  now(): number;
  /** Stops the agent's own process and drops it from the supervisor's map. */
  stopProcess(agent: string): void;
  /** Operator-facing Chinese notice for the console. */
  onNotice(agent: string, message: string): void;
  /**
   * Removes one directory tree. Injectable for the same reason `stopProcess`
   * and `onNotice` are: it is the one step that talks to the operating system,
   * and a caller that wants to prove the failure branch is reported honestly
   * should not have to make a real directory undeletable to do it.
   */
  removeDir?(target: string): { ok: true } | { ok: false; reason: string };
}

/** What one erasure removed, so the console can report it truthfully. */
export interface EraseReport {
  agent: string;
  rows: ErasedRows;
  /** Absolute paths removed from disk, in the order they were removed. */
  removedPaths: string[];
  /** Paths the removal could not touch. Empty on a clean run. */
  failedPaths: { path: string; reason: string }[];
}

export type EraseOutcome =
  | { ok: true; report: EraseReport }
  | { ok: false; error: 'agent_not_found' | 'invalid_name' };

/** Windows can hold a directory handle for a moment after a process dies. */
function removeDirectory(target: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(target)) {
    return { ok: true };
  }
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
  if (existsSync(target)) {
    return { ok: false, reason: 'the path still exists after removal' };
  }
  return { ok: true };
}

/**
 * Erases one agent completely. The caller has already validated the operator's
 * confirmation; this function does not ask again.
 */
export function eraseAgent(deps: EraseDeps, agent: string): EraseOutcome {
  // The name becomes a filesystem path below, so it is checked before anything
  // is read or deleted rather than trusting the caller.
  if (!AGENT_NAME_PATTERN.test(agent)) {
    return { ok: false, error: 'invalid_name' };
  }
  const record = deps.ledger.getAgent(agent);
  if (record === null) {
    return { ok: false, error: 'agent_not_found' };
  }

  // Stop first: a running round would otherwise append rows to a ledger that is
  // being cleared, and could rewrite MEMORY into a directory being removed.
  deps.stopProcess(agent);

  const at = deps.now();
  const rows = deps.ledger.eraseAgent(agent, at);
  const removedPaths: string[] = [];
  const failedPaths: { path: string; reason: string }[] = [];

  deps.blackbox.erase(agent);
  removedPaths.push(deps.blackbox.dirOf(agent));

  const home = agentHomeDir(deps.paths, agent);
  const remove = deps.removeDir ?? removeDirectory;
  const removed = remove(home);
  if (removed.ok) {
    removedPaths.push(home);
  } else {
    failedPaths.push({ path: home, reason: removed.reason });
  }

  deps.onNotice(
    agent,
    failedPaths.length === 0
      ? `操作员完全删除了 ${agent}：它的家目录、黑匣子与账本记录已抹除，此后如同从未存在。`
      : `操作员完全删除了 ${agent} 的账本记录，但有 ${failedPaths.length} 个路径没能删掉：${failedPaths
          .map((item) => item.path)
          .join('、')}。`,
  );

  return { ok: true, report: { agent, rows, removedPaths, failedPaths } };
}

/**
 * The paths an erasure would remove, for the console's confirmation text. It
 * only reads: a missing home is reported as absent rather than created.
 */
export function erasePreview(deps: EraseDeps, agent: string): { home: string; blackbox: string; homeExists: boolean } {
  const home = agentHomeDir(deps.paths, agent);
  let homeExists = false;
  try {
    homeExists = existsSync(home) && statSync(home).isDirectory();
  } catch {
    homeExists = false;
  }
  return { home, blackbox: deps.blackbox.dirOf(agent), homeExists };
}
