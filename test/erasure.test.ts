import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { eraseAgent, erasePreview } from '../src/organs/erasure';
import { agentHomeDir } from '../src/config';
import { createAgent } from '../src/organs/population';
import { Ledger } from '../src/organs/ledger';
import { birthAgent, createHarness, insertAgentRow, type Harness } from './helpers';

/** The erasure organ with a recorder standing in for the supervisor's map. */
function eraseDeps(h: Harness, stopped: string[] = [], notices: string[] = []) {
  return {
    ledger: h.ledger,
    blackbox: h.blackbox,
    paths: h.paths,
    now: h.clock.now,
    stopProcess: (agent: string) => {
      stopped.push(agent);
    },
    onNotice: (_agent: string, message: string) => {
      notices.push(message);
    },
  };
}

/** Every ledger row that names this agent, as a plain count. */
function rowsFor(ledger: Ledger, agent: string): number {
  return (
    ledger.listRounds(agent, 1000).length +
    ledger.sumUsage(agent, 'agent').records +
    ledger.sumUsage(agent, 'memory').records +
    ledger.listInterventions(agent).length +
    ledger.listMessagesForAgent(agent).length +
    ledger.listWounds(agent).length +
    ledger.listTreatments(agent).length +
    (ledger.getDeathCertificate(agent) === null ? 0 : 1) +
    ledger.listIncomeReports().filter((report) => report.agent === agent).length +
    (ledger.getSatietyAnchor(agent) === null ? 0 : 1)
  );
}

describe('erasing an agent leaves no trace of it', () => {
  it('removes the agent from the ledger, the roster, and every table naming it', () => {
    const h = createHarness({ values: { maxSlots: 4 } });
    try {
      const agent = birthAgent(h, 'ada');
      const now = h.clock.now();

      // Fill every table an agent can appear in, so the erasure is tested
      // against a ledger that is not conveniently empty.
      h.ledger.startRound('ada', now);
      h.ledger.appendUsage({ agent: 'ada', round: 1, source: 'agent', promptTokens: 10, completionTokens: 2, at: now });
      h.ledger.appendUsage({ agent: 'ada', round: 1, source: 'memory', promptTokens: 5, completionTokens: 1, at: now });
      h.ledger.appendMessage('ada', 'operator', 'hello', now);
      h.ledger.appendMessage('operator', 'ada', 'hi', now);
      h.ledger.appendIntervention('give_balance', 'ada', 'gave 5', now);
      h.ledger.insertFrozenSentence('ada', 'a sentence', now);
      h.ledger.insertWound({
        agent: 'ada',
        sentenceId: 1,
        offset: 0,
        length: 2,
        originalText: 'a ',
        starvationSince: 0,
        tickIndex: 1,
        createdAt: now,
      });
      h.ledger.insertIncomeReport({ agent: 'ada', where: 'upwork', work: 'x', amount: 1, currency: 'USD', at: now });
      h.blackbox.append('ada', 'round_start', now, 1, {});

      const home = agentHomeDir(h.paths, 'ada');
      writeFileSync(path.join(home, 'DEATH_CERTIFICATE.md'), 'gone soon', 'utf8');

      expect(rowsFor(h.ledger, 'ada')).toBeGreaterThan(0);
      expect(existsSync(home)).toBe(true);
      expect(existsSync(h.blackbox.filePath('ada', now))).toBe(true);

      const stopped: string[] = [];
      const outcome = eraseAgent(eraseDeps(h, stopped), 'ada');

      expect(outcome.ok).toBe(true);
      // The process is stopped before anything is removed.
      expect(stopped).toEqual(['ada']);
      // The agent is gone from the roster, and the name is free again.
      expect(h.ledger.getAgent('ada')).toBeNull();
      expect(h.ledger.listAgents()).toEqual([]);
      expect(rowsFor(h.ledger, 'ada')).toBe(0);
      // The home and the black box are gone from disk.
      expect(existsSync(home)).toBe(false);
      expect(existsSync(h.blackbox.dirOf('ada'))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('leaves one audit line, filed under the conservatory rather than the erased name', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const outcome = eraseAgent(eraseDeps(h), 'ada');
      expect(outcome.ok).toBe(true);

      // Filed under the erased name: nothing. Filed under the conservatory: the
      // operator's own record that they did this.
      expect(h.ledger.listInterventions('ada')).toEqual([]);
      const audit = h.ledger.listInterventions('conservatory');
      expect(audit).toHaveLength(1);
      expect(audit[0].kind).toBe('agent_erased');
      expect(audit[0].detail).toContain('ada');
    } finally {
      h.cleanup();
    }
  });

  it('frees the name for a fresh agent that inherits nothing', () => {
    const h = createHarness({ values: { maxSlots: 4 } });
    try {
      birthAgent(h, 'ada');
      // Spend the agent's balance so the successor's genesis is distinguishable.
      h.ledger.appendBalanceEvent('ada', -50, 'meal', null, h.clock.now());
      expect(h.ledger.getBalance('ada')).toBe(50);

      expect(eraseAgent(eraseDeps(h), 'ada').ok).toBe(true);

      h.clock.advanceSeconds(10);
      const reborn = birthAgent(h, 'ada');
      expect(reborn.name).toBe('ada');
      // A newborn starts from the configured genesis, not the predecessor's 50.
      expect(h.ledger.getBalance('ada')).toBe(h.values.initialBalance);
      expect(h.ledger.listRounds('ada', 10)).toEqual([]);
      expect(h.ledger.listInterventions('ada')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('clears the erased agent from a task without deleting the operator\'s task', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const now = h.clock.now();
      h.ledger.insertTask({
        id: 'task_0001',
        title: 'Count the clouds',
        description: 'How many?',
        price: 25,
        status: 'open',
        claimedBy: null,
        claimedAt: null,
        submittedAt: null,
        deliverable: null,
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
        decision: null,
      });
      h.ledger.claimTask('task_0001', 'ada', now);
      h.ledger.submitTask('task_0001', 'ada', 'I saw four.', now);

      const outcome = eraseAgent(eraseDeps(h), 'ada');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.report.rows.tasksReleased).toBe(1);
      }

      // The operator's own posting survives; only the erased agent's hold is gone.
      const task = h.ledger.getTask('task_0001');
      expect(task).not.toBeNull();
      expect(task?.claimedBy).toBeNull();
      expect(task?.status).toBe('open');
      expect(task?.deliverable).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('leaves other agents completely untouched', () => {
    const h = createHarness({ values: { maxSlots: 4 } });
    try {
      birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      const now = h.clock.now();
      h.ledger.appendMessage('bob', 'operator', 'bob here', now);
      h.ledger.startRound('bob', now);
      h.blackbox.append('bob', 'round_start', now, 1, {});
      const bobRows = rowsFor(h.ledger, 'bob');

      expect(eraseAgent(eraseDeps(h), 'ada').ok).toBe(true);

      expect(h.ledger.getAgent('bob')).not.toBeNull();
      expect(rowsFor(h.ledger, 'bob')).toBe(bobRows);
      expect(existsSync(h.blackbox.dirOf('bob'))).toBe(true);
      expect(existsSync(agentHomeDir(h.paths, 'bob'))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('erases a dead agent, including its death certificate', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      h.ledger.markAgentDead('ada');
      h.ledger.insertDeathCertificate({
        agent: 'ada',
        diedAt: h.clock.now(),
        cause: 'operator_termination',
        body: '{}',
      });
      expect(h.ledger.getDeathCertificate('ada')).not.toBeNull();

      const outcome = eraseAgent(eraseDeps(h), 'ada');
      expect(outcome.ok).toBe(true);
      expect(h.ledger.getAgent('ada')).toBeNull();
      expect(h.ledger.getDeathCertificate('ada')).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('works when the agent has no home on disk and nothing in the tables', () => {
    const h = createHarness();
    try {
      // A ledger-only agent: no files were ever written for it.
      insertAgentRow(h, 'ghost');
      const outcome = eraseAgent(eraseDeps(h), 'ghost');
      expect(outcome.ok).toBe(true);
      expect(h.ledger.getAgent('ghost')).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('refuses an unknown agent and an unsafe name, and changes nothing', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const before = rowsFor(h.ledger, 'ada');

      expect(eraseAgent(eraseDeps(h), 'nobody')).toEqual({ ok: false, error: 'agent_not_found' });
      // The name becomes a path inside the organ, so it is validated there too.
      expect(eraseAgent(eraseDeps(h), '../../escape')).toEqual({ ok: false, error: 'invalid_name' });
      expect(eraseAgent(eraseDeps(h), 'Ada')).toEqual({ ok: false, error: 'invalid_name' });

      expect(h.ledger.getAgent('ada')).not.toBeNull();
      expect(rowsFor(h.ledger, 'ada')).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  it('removes every black box day file, not only the newest one', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const first = h.clock.now();
      h.blackbox.append('ada', 'round_start', first, 1, {});
      h.clock.advance(24 * 3600 * 1000);
      const second = h.clock.now();
      h.blackbox.append('ada', 'round_start', second, 2, {});
      const dir = h.blackbox.dirOf('ada');
      expect(readdirSync(dir).length).toBe(2);

      expect(eraseAgent(eraseDeps(h), 'ada').ok).toBe(true);
      expect(existsSync(dir)).toBe(false);
      expect(h.blackbox.listDays('ada')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('previews the paths without creating or removing anything', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const preview = erasePreview(eraseDeps(h), 'ada');
      expect(preview.home).toBe(agentHomeDir(h.paths, 'ada'));
      expect(preview.homeExists).toBe(true);
      expect(existsSync(preview.home)).toBe(true);

      const absent = erasePreview(eraseDeps(h), 'nobody');
      expect(absent.homeExists).toBe(false);
      // A preview never creates the path it reports on.
      expect(existsSync(absent.home)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('reports a home it could not remove instead of staying silent', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const home = agentHomeDir(h.paths, 'ada');
      const notices: string[] = [];
      const deps = {
        ...eraseDeps(h, [], notices),
        removeDir: (): { ok: false; reason: string } => ({ ok: false, reason: 'locked by another process' }),
      };

      const outcome = eraseAgent(deps, 'ada');
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.report.failedPaths).toEqual([{ path: home, reason: 'locked by another process' }]);
        expect(outcome.report.removedPaths).not.toContain(home);
      }
      // The ledger row is gone even though the files are not, and the operator
      // is told exactly that rather than shown a silent success.
      expect(h.ledger.getAgent('ada')).toBeNull();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('没能删掉');
      expect(notices[0]).toContain(home);
    } finally {
      h.cleanup();
    }
  });

  it('keeps the append-only guards armed for every other agent afterwards', () => {
    const h = createHarness({ values: { maxSlots: 4 } });
    try {
      birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      h.ledger.appendBalanceEvent('bob', 5, 'intervention_balance', null, h.clock.now());

      // Before, during and after: the guards are the ledger's own claim, so they
      // are read from the ledger rather than from a private handle.
      expect(h.ledger.guardsAreArmed()).toBe(true);
      expect(eraseAgent(eraseDeps(h), 'ada').ok).toBe(true);
      expect(h.ledger.guardsAreArmed()).toBe(true);
      // The erasure permit went with the transaction; nothing stale is left.
      expect(h.ledger.erasePermits()).toEqual([]);
      // The other agent's row is still there and still undeletable.
      expect(h.ledger.getBalance('bob')).toBe(h.values.initialBalance + 5);
    } finally {
      h.cleanup();
    }
  });

  it('replaces the older, unconditional guards on a database that predates erasure', () => {
    const h = createHarness();
    try {
      // Reproduce the real upgrade path: a ledger whose delete trigger is the
      // original one, written before `erase_permits` existed. `CREATE TRIGGER IF
      // NOT EXISTS` would keep it, and erasure would then be permanently blocked
      // on exactly the databases it was written for.
      const raw = (h.ledger as unknown as { db: { exec: (sql: string) => void } }).db;
      raw.exec('DROP TRIGGER IF EXISTS interventions_no_delete;');
      raw.exec(`
        CREATE TRIGGER interventions_no_delete
        BEFORE DELETE ON interventions
        BEGIN
          SELECT RAISE(ABORT, 'interventions is append-only');
        END;
      `);
      h.ledger.close();

      // Reopening runs the schema again, which must drop and recreate the guard.
      const reopened = new Ledger(h.paths.ledgerPath);
      try {
        // Birth through the reopened handle: `h.ledger` is the closed one.
        const created = createAgent({
          name: 'ada',
          model: 'test-model',
          now: h.clock.now(),
          ledger: reopened,
          values: h.values,
          paths: h.paths,
        });
        expect(created.ok).toBe(true);
        const outcome = eraseAgent({ ...eraseDeps(h), ledger: reopened }, 'ada');
        expect(outcome.ok).toBe(true);
        expect(reopened.getAgent('ada')).toBeNull();
        expect(reopened.guardsAreArmed()).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
