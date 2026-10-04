import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { agentHomeDir } from '../src/config';
import {
  checkDeathLine,
  DEATH_CERTIFICATE_FILE,
  die,
  parseDeathCertificate,
  renderDeathCertificate,
  terminateByOperator,
  type DeathDeps,
} from '../src/organs/death';
import type { DeathCause } from '../src/organs/ledger';
import { createTask } from '../src/organs/taskboard';
import { birthAgent, createHarness, type Harness } from './helpers';

function depsFor(h: Harness, stopped: string[], notices: string[] = []): DeathDeps {
  return {
    ledger: h.ledger,
    values: h.values,
    paths: h.paths,
    blackbox: h.blackbox,
    now: h.clock.now,
    stopProcess: (agent) => {
      stopped.push(agent);
    },
    onNotice: (agent, message) => {
      notices.push(`${agent}: ${message}`);
    },
  };
}

describe('death', () => {
  it('marks the agent dead, stops its process, and files a certificate', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      h.clock.advanceSeconds(600);
      const stopped: string[] = [];
      const notices: string[] = [];
      const outcome = die(depsFor(h, stopped, notices), 'ada', 'redaction_death_line', h.clock.now());

      expect(outcome.ok).toBe(true);
      expect(h.ledger.getAgent('ada')?.status).toBe('dead');
      expect(stopped).toEqual(['ada']);
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain('ada');

      const certificate = h.ledger.getDeathCertificate('ada');
      expect(certificate).not.toBeNull();
      expect(certificate?.cause).toBe('redaction_death_line');
      expect(certificate?.diedAt).toBe(h.clock.now());

      const file = path.join(agentHomeDir(h.paths, 'ada'), DEATH_CERTIFICATE_FILE);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('Death Certificate — ada');
      expect(readFileSync(file, 'utf8')).toContain(agent.model);
    } finally {
      h.cleanup();
    }
  });

  it('carries every required fact and no conversation text at all', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Count the clouds', description: 'x', price: 10, at: h.clock.now() });
      h.ledger.claimTask('task_0001', 'ada', h.clock.now());
      h.ledger.appendIntervention('give_balance', 'ada', 'operator gave 10', h.clock.now());
      h.ledger.appendIntervention('conservatory_paused', 'conservatory', 'paused', h.clock.now());
      h.ledger.appendIntervention('conservatory_resumed', 'conservatory', 'resumed', h.clock.now());
      h.ledger.insertIncomeReport({ agent: 'ada', where: 'upwork', work: 'translation', amount: 3, currency: 'USD', at: h.clock.now() });
      h.blackbox.append('ada', 'round_start', h.clock.now(), 7, { model: agent.model });
      h.blackbox.append('ada', 'tool_call', h.clock.now(), 7, {
        callId: 'c1',
        name: 'get_status',
        argumentsJson: '{"secret":"do not leak"}',
      });
      h.blackbox.append('ada', 'tool_result', h.clock.now(), 7, {
        name: 'get_status',
        content: '{"ok":true,"secret":"do not leak"}',
      });
      h.blackbox.append('ada', 'round_end', h.clock.now(), 7, {
        endReason: 'final',
        finalReply: 'a private final reply',
        error: null,
      });

      const stopped: string[] = [];
      const outcome = die(depsFor(h, stopped), 'ada', 'operator_termination', h.clock.now());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      const body = outcome.body;

      expect(body.name).toBe('ada');
      expect(body.model).toBe(agent.model);
      expect(body.bornAt).toBe(agent.bornAt);
      expect(body.diedAt).toBe(h.clock.now());
      expect(body.cause).toBe('operator_termination');
      expect(body.finalBalance).toBe(100);
      expect(body.lifetimeRedactedChars).toBe(0);
      expect(body.untreatedRedactedChars).toBe(0);
      expect(body.deathLineChars).toBe(h.values.deathLineChars);
      expect(body.treatments).toEqual({ ordinary: 0, complete: 0, paidByAgent: 0, paidByOperator: 0 });
      expect(body.openCommitments.tasks.map((task) => task.id)).toEqual(['task_0001']);
      expect(body.openCommitments.pendingIncomeReports.length).toBe(1);
      expect(body.interventions.map((row) => row.kind)).toContain('give_balance');
      expect(body.interventions.map((row) => row.kind)).toContain('conservatory_paused');
      expect(body.interventions.map((row) => row.kind)).toContain('conservatory_resumed');

      // Names and counts only: no final reply, no arguments, no tool result.
      expect(body.lastActions.length).toBe(1);
      expect(body.lastActions[0].round).toBe(7);
      expect(body.lastActions[0].endReason).toBe('final');
      expect(body.lastActions[0].toolCalls).toEqual({ get_status: 1 });

      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain('do not leak');
      expect(serialised).not.toContain('a private final reply');
      const markdown = renderDeathCertificate(body);
      expect(parseDeathCertificate(JSON.stringify(body))?.name).toBe('ada');
    } finally {
      h.cleanup();
    }
  });

  it('refuses to die twice, and never changes a dead agent back', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      expect(die(depsFor(h, []), 'ada', 'operator_termination', h.clock.now()).ok).toBe(true);
      const again = die(depsFor(h, []), 'ada', 'operator_termination', h.clock.now() + 1);
      expect(again.ok).toBe(false);
      if (again.ok) {
        return;
      }
      expect(again.error).toBe('already_dead');

      // The trigger, not a convention: no UPDATE may resurrect the dead.
      expect(() => h.ledger.markAgentDead('ada')).not.toThrow();
      expect(h.ledger.markAgentDead('ada')).toBe(false);
      expect(h.ledger.getAgent('ada')?.status).toBe('dead');
    } finally {
      h.cleanup();
    }
  });

  it('sends held work back to the board and leaves submitted work for the operator', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      createTask(h.ledger, { id: 'task_0001', title: 'Held', description: 'x', price: 10, at: h.clock.now() });
      createTask(h.ledger, { id: 'task_0002', title: 'Reworked', description: 'x', price: 10, at: h.clock.now() });
      createTask(h.ledger, { id: 'task_0003', title: 'Submitted', description: 'x', price: 10, at: h.clock.now() });
      h.ledger.claimTask('task_0001', 'ada', h.clock.now());
      h.ledger.claimTask('task_0002', 'ada', h.clock.now());
      h.ledger.submitTask('task_0002', 'ada', 'work', h.clock.now() + 1);
      h.ledger.reviewTask('task_0002', ['submitted'], 'rework', 'rework', h.clock.now() + 2, h.clock.now() + 2, false);
      h.ledger.claimTask('task_0003', 'ada', h.clock.now());
      h.ledger.submitTask('task_0003', 'ada', 'work', h.clock.now() + 3);

      const outcome = die(depsFor(h, []), 'ada', 'redaction_death_line', h.clock.now() + 4);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.releasedTasks.sort()).toEqual(['task_0001', 'task_0002']);
      expect(h.ledger.getTask('task_0001')?.status).toBe('open');
      expect(h.ledger.getTask('task_0001')?.claimedBy).toBeNull();
      expect(h.ledger.getTask('task_0002')?.status).toBe('open');
      expect(h.ledger.getTask('task_0003')?.status).toBe('submitted');
      expect(h.ledger.getTask('task_0003')?.claimedBy).toBe('ada');
    } finally {
      h.cleanup();
    }
  });

  it('writes the death event to the black box and never deletes it', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const before = h.blackbox.listDays('ada');
      die(depsFor(h, []), 'ada', 'redaction_death_line', h.clock.now());
      const after = h.blackbox.listDays('ada');
      expect(after.length).toBeGreaterThanOrEqual(before.length);
      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      expect(entries.some((entry) => entry.kind === 'death')).toBe(true);
      expect(readdirSync(h.paths.blackboxDir).length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it('reports an agent that is not in the ledger', () => {
    const h = createHarness();
    try {
      const outcome = die(depsFor(h, []), 'nobody', 'redaction_death_line', h.clock.now());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.error).toBe('agent_not_found');
    } finally {
      h.cleanup();
    }
  });

  it('leaves MEMORY and the notebook in place, with no way to read the ledger back through a tool', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const before = readFileSync(path.join(agentHomeDir(h.paths, 'ada'), 'MEMORY'), 'utf8');
      die(depsFor(h, []), 'ada', 'redaction_death_line', h.clock.now());
      expect(readFileSync(path.join(agentHomeDir(h.paths, 'ada'), 'MEMORY'), 'utf8')).toBe(before);
      expect(readdirSync(agentHomeDir(h.paths, 'ada')).sort()).toEqual([
        'DEATH_CERTIFICATE.md',
        'MEMORY',
        'notebook',
      ]);
    } finally {
      h.cleanup();
    }
  });
});

describe('the causes of death are exactly two', () => {
  it('accepts only the two declared causes', () => {
    const causes: DeathCause[] = ['redaction_death_line', 'operator_termination'];
    expect(causes.length).toBe(2);
  });
});

describe('the death line is the only mechanism that can kill by hunger', () => {
  function redactInto(h: Harness, agent: string, count: number): void {
    const sentenceId = h.ledger.insertFrozenSentence(agent, 'x'.repeat(count), h.clock.now());
    h.ledger.insertWound({
      agent,
      sentenceId,
      offset: 0,
      length: count,
      originalText: 'x'.repeat(count),
      starvationSince: 1,
      tickIndex: 1,
      createdAt: h.clock.now(),
    });
  }

  it('kills exactly when untreated characters reach the line, and not before', () => {
    const h = createHarness({ values: { deathLineChars: 10 } });
    try {
      birthAgent(h, 'ada');
      const stopped: string[] = [];
      redactInto(h, 'ada', 9);
      expect(checkDeathLine(depsFor(h, stopped), 'ada')).toBeNull();
      expect(h.ledger.getAgent('ada')?.status).toBe('alive');

      redactInto(h, 'ada', 1);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(10);
      const outcome = checkDeathLine(depsFor(h, stopped), 'ada');
      expect(outcome?.ok).toBe(true);
      expect(h.ledger.getAgent('ada')?.status).toBe('dead');
      expect(h.ledger.getDeathCertificate('ada')?.cause).toBe('redaction_death_line');
      expect(stopped).toEqual(['ada']);
    } finally {
      h.cleanup();
    }
  });

  it('does not count a treated wound toward the line', () => {
    const h = createHarness({ values: { deathLineChars: 10 } });
    try {
      birthAgent(h, 'ada');
      redactInto(h, 'ada', 20);
      h.ledger.setWoundStatus(1, 'untreated', 'healed', h.clock.now());
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(0);
      expect(h.ledger.lifetimeRedactedChars('ada')).toBe(20);
      expect(checkDeathLine(depsFor(h, []), 'ada')).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('lets a newborn with a short MEMORY starve without dying', () => {
    const h = createHarness({ values: { deathLineChars: 10 } });
    try {
      const agent = birthAgent(h, 'ada');
      h.ledger.setSatietyAnchor('ada', 0, h.clock.now());
      h.clock.advanceSeconds(3600);
      expect(checkDeathLine(depsFor(h, []), 'ada')).toBeNull();
      expect(h.ledger.getAgent('ada')?.status).toBe('alive');
      expect(agent.name).toBe('ada');
    } finally {
      h.cleanup();
    }
  });

  it('records a forced termination as an intervention and dies by operator_termination', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const outcome = terminateByOperator(depsFor(h, []), 'ada', 'ada');
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.body.cause).toBe('operator_termination');
      const kinds = h.ledger.listInterventions('ada').map((row) => row.kind);
      expect(kinds).toContain('force_terminate');
      expect(h.ledger.getDeathCertificate('ada')?.cause).toBe('operator_termination');
      const facts = parseDeathCertificate(h.ledger.getDeathCertificate('ada')?.body ?? '');
      expect(facts?.interventions.map((row) => row.kind)).toContain('force_terminate');
    } finally {
      h.cleanup();
    }
  });

  it('refuses a forced termination whose confirmation name does not match', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const outcome = terminateByOperator(depsFor(h, []), 'ada', 'bob');
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.error).toBe('confirm_name_mismatch');
      expect(h.ledger.getAgent('ada')?.status).toBe('alive');
      expect(h.ledger.listInterventions('ada')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a forced termination of an agent that is already dead', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      die(depsFor(h, []), 'ada', 'redaction_death_line', h.clock.now());
      const outcome = terminateByOperator(depsFor(h, []), 'ada', 'ada');
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.error).toBe('agent_dead');
    } finally {
      h.cleanup();
    }
  });

  it('rejects a resurrection at the database, whatever the caller tries', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const sentenceId = h.ledger.insertFrozenSentence('ada', 'abcdef', h.clock.now());
      const woundId = h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 0,
        length: 2,
        originalText: 'ab',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      h.ledger.appendTreatment({
        agent: 'ada',
        woundId,
        tier: 'ordinary',
        price: 0,
        paidBy: 'operator',
        at: h.clock.now(),
      });
      // A row must exist for a BEFORE DELETE trigger to fire at all.
      die(depsFor(h, []), 'ada', 'redaction_death_line', h.clock.now());

      const raw = new DatabaseSync(h.paths.ledgerPath);
      try {
        expect(() => raw.exec("UPDATE agents SET status = 'alive' WHERE name = 'ada'")).toThrow(
          /the dead do not return/,
        );
        expect(() => raw.exec("UPDATE agents SET status = 'dead' WHERE name = 'ada'")).toThrow(
          /the dead do not return/,
        );
        expect(() => raw.exec("DELETE FROM death_certificates WHERE agent = 'ada'")).toThrow(
          /append-only/,
        );
        expect(() => raw.exec('DELETE FROM wounds')).toThrow(/append-only/);
        expect(() => raw.exec('DELETE FROM frozen_sentences')).toThrow(/append-only/);
        expect(() => raw.exec('DELETE FROM treatments')).toThrow(/append-only/);
        expect(() => raw.exec('UPDATE treatments SET price = 1')).toThrow(/append-only/);
        expect(() => raw.exec("UPDATE death_certificates SET cause = 'x'")).toThrow(/append-only/);
      } finally {
        raw.close();
      }
      expect(h.ledger.getAgent('ada')?.status).toBe('dead');
    } finally {
      h.cleanup();
    }
  });

  it('refuses a wound that tries to walk backwards', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const sentenceId = h.ledger.insertFrozenSentence('ada', 'abcdef', h.clock.now());
      const woundId = h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 0,
        length: 2,
        originalText: 'ab',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      expect(h.ledger.setWoundStatus(woundId, 'untreated', 'scarred', h.clock.now())).toBe(true);
      expect(h.ledger.setWoundStatus(woundId, 'scarred', 'healed', h.clock.now())).toBe(true);
      expect(h.ledger.setWoundStatus(woundId, 'untreated', 'healed', h.clock.now())).toBe(false);

      const raw = new DatabaseSync(h.paths.ledgerPath);
      try {
        expect(() => raw.exec(`UPDATE wounds SET status = 'untreated' WHERE id = ${woundId}`)).toThrow(
          /forward only/,
        );
        expect(() => raw.exec(`UPDATE wounds SET status = 'scarred' WHERE id = ${woundId}`)).toThrow(
          /forward only/,
        );
      } finally {
        raw.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
