import { withOperatorNote, type Ledger, type TaskRecord, type TaskStatus } from './ledger';

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
 * Operator edit of a task that is still on the board. Once an agent holds the
 * task its terms are fixed: an agent that claimed a 30-balance job must not
 * find it silently repriced to 3.
 */
export function updateTask(
  ledger: Ledger,
  taskId: string,
  patch: { title: string; description: string; price: number },
  at: number,
): TaskResult {
  if (patch.title.trim() === '') {
    return { ok: false, code: 'invalid_title', status: null };
  }
  if (!Number.isFinite(patch.price) || patch.price < 0) {
    return { ok: false, code: 'invalid_price', status: null };
  }
  const existing = ledger.getTask(taskId);
  if (existing === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  if (existing.status !== 'open') {
    return { ok: false, code: 'task_not_open', status: existing.status };
  }
  const changed = ledger.transaction(() =>
    ledger.updateOpenTask(taskId, patch.title.trim(), patch.description, patch.price, at),
  );
  if (!changed) {
    const current = ledger.getTask(taskId);
    return { ok: false, code: 'task_not_open', status: current === null ? null : current.status };
  }
  const task = ledger.getTask(taskId);
  if (task === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  return { ok: true, task };
}

/**
 * Takes an open task off the board. The row is deleted rather than marked,
 * because a task nobody ever claimed has no history worth keeping — the
 * submission trail that would matter belongs to claimed work.
 */
export function cancelTask(
  ledger: Ledger,
  taskId: string,
): { ok: true; id: string } | { ok: false; code: TaskErrorCode; status: TaskStatus | null } {
  const existing = ledger.getTask(taskId);
  if (existing === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  if (existing.status !== 'open') {
    return { ok: false, code: 'task_not_open', status: existing.status };
  }
  const removed = ledger.transaction(() => ledger.deleteOpenTask(taskId));
  if (!removed) {
    const current = ledger.getTask(taskId);
    return { ok: false, code: 'task_not_open', status: current === null ? null : current.status };
  }
  return { ok: true, id: taskId };
}

/**
 * Operator review. Payment happens inside the same transaction as the guarded
 * status change, so an accepted task pays exactly once and a rejected one pays
 * nothing. The decision is announced to the agent that held the task, in the
 * same transaction: a notice that could arrive without the decision, or a
 * decision the agent is never told about, would both be worse than neither.
 */
export function reviewTask(
  ledger: Ledger,
  taskId: string,
  decision: ReviewDecision,
  at: number,
  note?: string,
): TaskResult {
  const existing = ledger.getTask(taskId);
  if (existing === null) {
    return { ok: false, code: 'task_not_found', status: null };
  }
  // `return` also reaches a task an agent has stalled on; the other three
  // decisions only ever apply to work that was actually handed in.
  const allowedFrom: readonly TaskStatus[] =
    decision === 'return' ? ['submitted', 'claimed', 'rework'] : ['submitted'];
  if (!allowedFrom.includes(existing.status)) {
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
    let applied: boolean;
    if (decision === 'accept') {
      applied = ledger.reviewTask(taskId, ['submitted'], 'accepted', 'accepted', at, null, false);
      if (!applied) {
        return false;
      }
      const payer = existing.claimedBy;
      if (payer === null) {
        throw new Error(`task ${taskId} was accepted without a claiming agent`);
      }
      ledger.appendBalanceEvent(payer, existing.price, 'task_payment', taskId, at);
    } else if (decision === 'reject') {
      applied = ledger.reviewTask(taskId, ['submitted'], 'rejected', 'rejected', at, null, false);
    } else if (decision === 'rework') {
      // Back to the same agent, with the claim clock restarted.
      applied = ledger.reviewTask(taskId, ['submitted'], 'rework', 'rework', at, at, false);
    } else {
      applied = ledger.returnTaskToBoard(taskId, at);
    }
    if (applied && existing.claimedBy !== null) {
      ledger.appendMessage('system', existing.claimedBy, decisionNotice(decision, existing, note), at);
    }
    return applied;
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

/** The English harness notice for one review decision, plus the operator's note. */
function decisionNotice(decision: ReviewDecision, task: TaskRecord, note: string | undefined): string {
  const head = `Task ${task.id} ("${task.title}")`;
  if (decision === 'accept') {
    return withOperatorNote(`${head} was accepted (+${task.price} balance).`, note);
  }
  if (decision === 'reject') {
    return withOperatorNote(`${head} was rejected (no payment).`, note);
  }
  if (decision === 'rework') {
    return withOperatorNote(`${head} was sent back for rework.`, note);
  }
  return withOperatorNote(`${head} was returned to the task board by the operator.`, note);
}

/** Called from the heartbeat: claims past the timeout return to the board. */
export function expireClaims(
  ledger: Ledger,
  now: number,
  timeoutHours: number,
): { taskId: string; agent: string }[] {
  return ledger.expireClaimedTasks(now, timeoutHours * 3600 * 1000);
}
