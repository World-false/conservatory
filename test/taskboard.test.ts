import { describe, expect, it } from 'vitest';
import {
  cancelTask,
  claimTask,
  createTask,
  expireClaims,
  listBoardTasks,
  reviewTask,
  submitTask,
  updateTask,
} from '../src/organs/taskboard';
import { birthAgent, createHarness, insertAgentRow } from './helpers';

function paymentEvents(h: ReturnType<typeof createHarness>): number {
  return h.ledger.listBalanceEvents('ada').filter((event) => event.reason === 'task_payment').length;
}

/** The English system notices an agent has waiting, oldest first. */
function systemNotices(h: ReturnType<typeof createHarness>, agent: string): string[] {
  return h.ledger
    .listUnreadMessages(agent)
    .filter((message) => message.sender === 'system')
    .map((message) => message.body);
}

describe('the task board state machine', () => {
  it('creates an open task in the fixed-price form', () => {
    const h = createHarness();
    try {
      const result = createTask(h.ledger, {
        id: 'task_0001',
        title: 'Write a poem',
        description: 'Twelve lines about rain.',
        price: 40,
        at: h.clock.now(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.task.status).toBe('open');
      expect(result.task.claimedBy).toBeNull();
      expect(listBoardTasks(h.ledger, 'ada').open.map((task) => task.id)).toEqual(['task_0001']);
    } finally {
      h.cleanup();
    }
  });

  it('refuses an empty title and a negative price', () => {
    const h = createHarness();
    try {
      const emptyTitle = createTask(h.ledger, { id: 'a', title: '   ', description: '', price: 1, at: 0 });
      expect(emptyTitle.ok).toBe(false);
      const negative = createTask(h.ledger, { id: 'b', title: 'x', description: '', price: -1, at: 0 });
      expect(negative.ok).toBe(false);
      expect(h.ledger.listTasks()).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('lets exactly one agent claim an open task', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertAgentRow(h, 'bob');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });

      const first = claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      expect(first.ok).toBe(true);
      const second = claimTask(h.ledger, 'bob', 'task_0001', h.clock.now());
      expect(second.ok).toBe(false);
      if (second.ok) {
        return;
      }
      expect(second.code).toBe('task_not_open');

      const mine = listBoardTasks(h.ledger, 'ada').mine;
      expect(mine.map((task) => task.id)).toEqual(['task_0001']);
      expect(listBoardTasks(h.ledger, 'ada').open).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('lets only the claimer submit, and only from claimed or rework', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertAgentRow(h, 'bob');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());

      const wrongAgent = submitTask(h.ledger, 'bob', 'task_0001', 'done', h.clock.now());
      expect(wrongAgent.ok).toBe(false);
      const emptyDeliverable = submitTask(h.ledger, 'ada', 'task_0001', '   ', h.clock.now());
      expect(emptyDeliverable.ok).toBe(false);
      const ok = submitTask(h.ledger, 'ada', 'task_0001', 'done', h.clock.now());
      expect(ok.ok).toBe(true);
      if (!ok.ok) {
        return;
      }
      expect(ok.task.status).toBe('submitted');
      expect(h.ledger.getTask('task_0001')?.deliverable).toBe('done');

      const again = submitTask(h.ledger, 'ada', 'task_0001', 'done again', h.clock.now());
      expect(again.ok).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('pays exactly once on acceptance', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'done', h.clock.now());
      const balanceBefore = h.ledger.getBalance('ada');

      const accepted = reviewTask(h.ledger, 'task_0001', 'accept', h.clock.now());
      expect(accepted.ok).toBe(true);
      expect(h.ledger.getBalance('ada')).toBe(balanceBefore + 30);
      expect(paymentEvents(h)).toBe(1);

      const acceptedAgain = reviewTask(h.ledger, 'task_0001', 'accept', h.clock.now());
      expect(acceptedAgain.ok).toBe(false);
      if (acceptedAgain.ok) {
        return;
      }
      expect(acceptedAgain.code).toBe('task_not_submitted');
      expect(h.ledger.getBalance('ada')).toBe(balanceBefore + 30);
      expect(paymentEvents(h)).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('refuses to pay a dead claimant and leaves the task submitted', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'done', h.clock.now());
      const balanceBefore = h.ledger.getBalance('ada');
      expect(h.ledger.markAgentDead('ada')).toBe(true);

      const result = reviewTask(h.ledger, 'task_0001', 'accept', h.clock.now());
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe('claimant_not_alive');
      expect(h.ledger.getTask('task_0001')?.status).toBe('submitted');
      expect(h.ledger.getBalance('ada')).toBe(balanceBefore);
      expect(paymentEvents(h)).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('pays nothing on rejection and closes the task', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'done', h.clock.now());
      const balanceBefore = h.ledger.getBalance('ada');

      const rejected = reviewTask(h.ledger, 'task_0001', 'reject', h.clock.now());
      expect(rejected.ok).toBe(true);
      expect(h.ledger.getBalance('ada')).toBe(balanceBefore);
      expect(paymentEvents(h)).toBe(0);
      expect(h.ledger.getTask('task_0001')?.status).toBe('rejected');
      expect(listBoardTasks(h.ledger, 'ada').open).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('sends a task back for rework to the same agent, who can submit again', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'first try', h.clock.now());

      const rework = reviewTask(h.ledger, 'task_0001', 'rework', h.clock.now());
      expect(rework.ok).toBe(true);
      expect(h.ledger.getTask('task_0001')?.status).toBe('rework');
      expect(h.ledger.getTask('task_0001')?.claimedBy).toBe('ada');
      expect(listBoardTasks(h.ledger, 'ada').mine.map((task) => task.id)).toEqual(['task_0001']);

      const resubmitted = submitTask(h.ledger, 'ada', 'task_0001', 'second try', h.clock.now());
      expect(resubmitted.ok).toBe(true);
      expect(h.ledger.getTask('task_0001')?.deliverable).toBe('second try');
      expect(h.ledger.listTaskSubmissions('task_0001').length).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it('returns a submitted task to the board for anyone, clearing the claim', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertAgentRow(h, 'bob');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'done', h.clock.now());

      const returned = reviewTask(h.ledger, 'task_0001', 'return', h.clock.now());
      expect(returned.ok).toBe(true);
      expect(h.ledger.getTask('task_0001')?.status).toBe('open');
      expect(h.ledger.getTask('task_0001')?.claimedBy).toBeNull();

      const bobClaims = claimTask(h.ledger, 'bob', 'task_0001', h.clock.now());
      expect(bobClaims.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('cannot review a task that is only claimed', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      const result = reviewTask(h.ledger, 'task_0001', 'accept', h.clock.now());
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe('task_not_submitted');
    } finally {
      h.cleanup();
    }
  });

  it('reports a task that does not exist', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      expect(claimTask(h.ledger, 'ada', 'nope', h.clock.now()).ok).toBe(false);
      expect(submitTask(h.ledger, 'ada', 'nope', 'x', h.clock.now()).ok).toBe(false);
      expect(reviewTask(h.ledger, 'nope', 'accept', h.clock.now()).ok).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('returns a claim to the board after the timeout', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertAgentRow(h, 'bob');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());

      const almost = expireClaims(h.ledger, h.clock.now() + 23 * 3600 * 1000, h.values.taskClaimTimeoutHours);
      expect(almost).toEqual([]);
      expect(h.ledger.getTask('task_0001')?.status).toBe('claimed');

      const expired = expireClaims(h.ledger, h.clock.now() + 25 * 3600 * 1000, h.values.taskClaimTimeoutHours);
      expect(expired).toEqual([{ taskId: 'task_0001', agent: 'ada' }]);
      const task = h.ledger.getTask('task_0001');
      expect(task?.status).toBe('open');
      expect(task?.claimedBy).toBeNull();
      expect(task?.claimedAt).toBeNull();

      const bobClaims = claimTask(h.ledger, 'bob', 'task_0001', h.clock.now());
      expect(bobClaims.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('does not expire a claim that was already submitted', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'done', h.clock.now());
      const expired = expireClaims(h.ledger, h.clock.now() + 100 * 3600 * 1000, h.values.taskClaimTimeoutHours);
      expect(expired).toEqual([]);
      expect(h.ledger.getTask('task_0001')?.status).toBe('submitted');
    } finally {
      h.cleanup();
    }
  });

  it('expires a task sent back for rework just like a fresh claim', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'first try', h.clock.now());
      reviewTask(h.ledger, 'task_0001', 'rework', h.clock.now());
      expect(h.ledger.getTask('task_0001')?.status).toBe('rework');

      const almost = expireClaims(h.ledger, h.clock.now() + 23 * 3600 * 1000, h.values.taskClaimTimeoutHours);
      expect(almost).toEqual([]);
      const expired = expireClaims(h.ledger, h.clock.now() + 25 * 3600 * 1000, h.values.taskClaimTimeoutHours);
      expect(expired).toEqual([{ taskId: 'task_0001', agent: 'ada' }]);
      expect(h.ledger.getTask('task_0001')?.status).toBe('open');
      expect(h.ledger.getTask('task_0001')?.claimedBy).toBeNull();
      expect(listBoardTasks(h.ledger, 'ada').mine).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe('editing and withdrawing a task that is still on the board', () => {
  it('edits the title, description and price of an open task', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });

      const edited = updateTask(
        h.ledger,
        'task_0001',
        { title: '  Better work  ', description: 'Do it properly.', price: 45 },
        h.clock.now() + 1000,
      );
      expect(edited.ok).toBe(true);
      if (!edited.ok) {
        return;
      }
      expect(edited.task.title).toBe('Better work');
      expect(edited.task.description).toBe('Do it properly.');
      expect(edited.task.price).toBe(45);
      expect(edited.task.updatedAt).toBe(h.clock.now() + 1000);
      expect(edited.task.status).toBe('open');
    } finally {
      h.cleanup();
    }
  });

  it('refuses an empty title and a negative price without touching the task', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });

      const badTitle = updateTask(h.ledger, 'task_0001', { title: '   ', description: 'x', price: 5 }, 1);
      expect(badTitle.ok).toBe(false);
      if (!badTitle.ok) {
        expect(badTitle.code).toBe('invalid_title');
      }
      const badPrice = updateTask(h.ledger, 'task_0001', { title: 'x', description: 'x', price: -1 }, 1);
      expect(badPrice.ok).toBe(false);
      if (!badPrice.ok) {
        expect(badPrice.code).toBe('invalid_price');
      }
      const task = h.ledger.getTask('task_0001');
      expect(task?.title).toBe('Work');
      expect(task?.price).toBe(30);
    } finally {
      h.cleanup();
    }
  });

  it('refuses to edit or withdraw a task once an agent has claimed it', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());

      const edited = updateTask(h.ledger, 'task_0001', { title: 'Cheaper', description: 'x', price: 1 }, 1);
      expect(edited.ok).toBe(false);
      if (!edited.ok) {
        expect(edited.code).toBe('task_not_open');
        expect(edited.status).toBe('claimed');
      }
      const cancelled = cancelTask(h.ledger, 'task_0001');
      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok) {
        expect(cancelled.code).toBe('task_not_open');
      }
      // The task is still there, with its original terms.
      const task = h.ledger.getTask('task_0001');
      expect(task?.title).toBe('Work');
      expect(task?.price).toBe(30);
      expect(task?.status).toBe('claimed');
    } finally {
      h.cleanup();
    }
  });

  it('withdraws an open task, and reports one that does not exist', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });

      const cancelled = cancelTask(h.ledger, 'task_0001');
      expect(cancelled).toEqual({ ok: true, id: 'task_0001' });
      expect(h.ledger.getTask('task_0001')).toBeNull();
      expect(listBoardTasks(h.ledger, 'ada').open).toEqual([]);

      const missing = cancelTask(h.ledger, 'nope');
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.code).toBe('task_not_found');
      }
      const missingEdit = updateTask(h.ledger, 'nope', { title: 'x', description: 'x', price: 1 }, 1);
      expect(missingEdit.ok).toBe(false);
      if (!missingEdit.ok) {
        expect(missingEdit.code).toBe('task_not_found');
      }
    } finally {
      h.cleanup();
    }
  });
});

describe('the operator pulling a stalled task back to the board', () => {
  it('returns a claimed task to the board and tells the agent why', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertAgentRow(h, 'bob');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());

      const returned = reviewTask(h.ledger, 'task_0001', 'return', h.clock.now(), 'Taking too long');
      expect(returned.ok).toBe(true);
      const task = h.ledger.getTask('task_0001');
      expect(task?.status).toBe('open');
      expect(task?.claimedBy).toBeNull();
      expect(task?.claimedAt).toBeNull();

      // The claim clock is cleared with the claim, so the timeout sweep can
      // never resurrect this row.
      const expired = expireClaims(h.ledger, h.clock.now() + 100 * 3600 * 1000, h.values.taskClaimTimeoutHours);
      expect(expired).toEqual([]);

      const notices = systemNotices(h, 'ada');
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain('was returned to the task board by the operator');
      expect(notices[0]).toContain('Note from operator: Taking too long');
      // English harness text, as the agent's next round injects it.
      expect(notices[0]).toContain('Task task_0001 ("Work")');

      // And anyone can pick it up again.
      const bobClaims = claimTask(h.ledger, 'bob', 'task_0001', h.clock.now());
      expect(bobClaims.ok).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('returns a rework task to the board as well', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'first try', h.clock.now());
      reviewTask(h.ledger, 'task_0001', 'rework', h.clock.now());
      expect(h.ledger.getTask('task_0001')?.status).toBe('rework');

      const returned = reviewTask(h.ledger, 'task_0001', 'return', h.clock.now());
      expect(returned.ok).toBe(true);
      expect(h.ledger.getTask('task_0001')?.status).toBe('open');
      expect(h.ledger.getTask('task_0001')?.claimedBy).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('still refuses to accept or reject a task that is only claimed', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());

      for (const decision of ['accept', 'reject', 'rework'] as const) {
        const result = reviewTask(h.ledger, 'task_0001', decision, h.clock.now());
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.code).toBe('task_not_submitted');
        }
      }
      // Nothing was paid and nothing was announced.
      expect(paymentEvents(h)).toBe(0);
      expect(systemNotices(h, 'ada')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe('the system notice a review sends the agent', () => {
  it('announces acceptance with the amount, and the operator note', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'done', h.clock.now());

      const accepted = reviewTask(h.ledger, 'task_0001', 'accept', h.clock.now(), 'Clean work, thank you');
      expect(accepted.ok).toBe(true);
      const notices = systemNotices(h, 'ada');
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain('was accepted (+30 balance)');
      expect(notices[0]).toContain('Note from operator: Clean work, thank you');
    } finally {
      h.cleanup();
    }
  });

  it('announces rework and rejection, with no note suffix when none was given', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 30, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      submitTask(h.ledger, 'ada', 'task_0001', 'done', h.clock.now());

      reviewTask(h.ledger, 'task_0001', 'rework', h.clock.now(), 'Needs a second pass');
      const afterRework = systemNotices(h, 'ada');
      expect(afterRework.length).toBe(1);
      expect(afterRework[0]).toContain('was sent back for rework');
      expect(afterRework[0]).toContain('Note from operator: Needs a second pass');

      submitTask(h.ledger, 'ada', 'task_0001', 'second try', h.clock.now());
      // A blank note must not leave a dangling " Note from operator:" suffix.
      reviewTask(h.ledger, 'task_0001', 'reject', h.clock.now(), '   ');
      const afterReject = systemNotices(h, 'ada');
      expect(afterReject.length).toBe(2);
      expect(afterReject[1]).toContain('was rejected (no payment)');
      expect(afterReject[1]).not.toContain('Note from operator');
      expect(afterReject[1].endsWith('(no payment).')).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

