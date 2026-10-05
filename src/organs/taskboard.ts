import type { Ledger, TaskRecord, TaskStatus } from './ledger';

export type TaskErrorCode =
  | 'task_not_found'
  | 'task_not_open'
  | 'task_not_claimed_by_you'
  | 'task_not_submitted'
  | 'claimant_not_alive'
  | 'invalid_title'
  | 'invalid_price'
  | 'invalid_deliverable';

export type TaskResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; code: TaskErrorCode; status: TaskStatus | null };

export type ReviewDecision = 'accept' | 'reject' | 'rework' | 'return';

export interface CreateTaskInput {
  id: string;
  title: string;
  description: string;
  price: number;
  at: number;
}

const OPEN_STATUSES: readonly TaskStatus[] = ['open'];
const MINE_STATUSES: readonly TaskStatus[] = ['claimed', 'rework'];

/**
 * Step 1 implements one task form only: fixed price, first come first served.
 * Note there is deliberately no bidding and no contest.
 */
export function createTask(ledger: Ledger, input: CreateTaskInput): TaskResult {
  if (input.title.trim() === '') {
    return { ok: false, code: 'invalid_title', status: null };
  }
  if (!Number.isFinite(input.price) || input.price < 0) {
    return { ok: false, code: 'invalid_price', status: null };
  }
  const task: TaskRecord = {
    id: input.id,
    title: input.title.trim(),
    description: input.description,
    price: input.price,
    status: 'open',
    claimedBy: null,
    claimedAt: null,
    submittedAt: null,
    deliverable: null,
    createdAt: input.at,
    updatedAt: input.at,
    decidedAt: null,
    decision: null,
  };
  ledger.insertTask(task);
  return { ok: true, task };
}

export function listBoardTasks(
  ledger: Ledger,
  agent: string,
): { open: TaskRecord[]; mine: TaskRecord[] } {
  const open = ledger.listTasks(OPEN_STATUSES);
  const mine = ledger
    .listTasks(MINE_STATUSES)
    .filter((task) => task.claimedBy === agent);
  return { open, mine };
}

export function claimTask(ledger: Ledger, agent: string, taskId: string, at: number): TaskResult {
  const existing = ledger.getTask(taskId);
  if (existing === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  if (existing.status !== 'open') {
    return { ok: false, code: 'task_not_open', status: existing.status };
  }
  const claimed = ledger.transaction(() => ledger.claimTask(taskId, agent, at));
  if (!claimed) {
    const current = ledger.getTask(taskId);
    return { ok: false, code: 'task_not_open', status: current === null ? null : current.status };
  }
  const task = ledger.getTask(taskId);
  if (task === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  return { ok: true, task };
}

export function submitTask(
  ledger: Ledger,
  agent: string,
  taskId: string,
  deliverable: string,
  at: number,
): TaskResult {
  if (deliverable.trim() === '') {
    return { ok: false, code: 'invalid_deliverable', status: null };
  }
  const existing = ledger.getTask(taskId);
  if (existing === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  if (existing.claimedBy !== agent) {
    return { ok: false, code: 'task_not_claimed_by_you', status: existing.status };
  }
  if (existing.status !== 'claimed' && existing.status !== 'rework') {
    return { ok: false, code: 'task_not_submitted', status: existing.status };
  }
  const submitted = ledger.transaction(() => {
    const changed = ledger.submitTask(taskId, agent, deliverable, at);
    if (changed) {
      ledger.appendTaskSubmission(taskId, agent, deliverable, at);
    }
    return changed;
  });
  if (!submitted) {
    const current = ledger.getTask(taskId);
    return { ok: false, code: 'task_not_submitted', status: current === null ? null : current.status };
  }
  const task = ledger.getTask(taskId);
  if (task === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  return { ok: true, task };
}

/**
 * Operator review. Payment happens inside the same transaction as the guarded
 * status change, so an accepted task pays exactly once and a rejected one pays
 * nothing.
 */
export function reviewTask(
  ledger: Ledger,
  taskId: string,
  decision: ReviewDecision,
  at: number,
): TaskResult {
  const existing = ledger.getTask(taskId);
  if (existing === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  if (existing.status !== 'submitted') {
    return { ok: false, code: 'task_not_submitted', status: existing.status };
  }
  if (decision === 'accept') {
    const payer = existing.claimedBy;
    if (payer === null) {
      throw new Error(`task ${taskId} was accepted without a claiming agent`);
    }
    // Paying a dead agent would credit a balance the death certificate already
    // recorded as final, and the certificate is append-only. Refuse instead.
    const claimant = ledger.getAgent(payer);
    if (claimant === null || claimant.status !== 'alive') {
      return { ok: false, code: 'claimant_not_alive', status: existing.status };
    }
  }

  const changed = ledger.transaction(() => {
    if (decision === 'accept') {
      const accepted = ledger.reviewTask(taskId, ['submitted'], 'accepted', 'accepted', at, null, false);
      if (!accepted) {
        return false;
      }
      const payer = existing.claimedBy;
      if (payer === null) {
        throw new Error(`task ${taskId} was accepted without a claiming agent`);
      }
      ledger.appendBalanceEvent(payer, existing.price, 'task_payment', taskId, at);
      return true;
    }
    if (decision === 'reject') {
      return ledger.reviewTask(taskId, ['submitted'], 'rejected', 'rejected', at, null, false);
    }
    if (decision === 'rework') {
      // Back to the same agent, with the claim clock restarted.
      return ledger.reviewTask(taskId, ['submitted'], 'rework', 'rework', at, at, false);
    }
    return ledger.returnTaskToBoard(taskId, at);
  });

  if (!changed) {
    const current = ledger.getTask(taskId);
    return { ok: false, code: 'task_not_submitted', status: current === null ? null : current.status };
  }
  const task = ledger.getTask(taskId);
  if (task === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  return { ok: true, task };
}

/** Called from the heartbeat: claims past the timeout return to the board. */
export function expireClaims(
  ledger: Ledger,
  now: number,
  timeoutHours: number,
): { taskId: string; agent: string }[] {
  return ledger.expireClaimedTasks(now, timeoutHours * 3600 * 1000);
}
