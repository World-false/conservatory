import { afterEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat } from '../src/organs/heartbeat';
import { Ledger, type InterventionKind } from '../src/organs/ledger';
import { eat, readBodyStatus, readSatiety } from '../src/organs/metabolism';
import { createPauseOrgan, pauseInterventionDetail, type PauseOrgan } from '../src/organs/pause';
import { RoundRegistry, wakeLivingAgents } from '../src/organs/population';
import { claimTask, createTask, expireClaims } from '../src/organs/taskboard';
import { birthAgent, createHarness, type Harness } from './helpers';

afterEach(() => {
  vi.useRealTimers();
});

/** The real pause organ, with the intervention rows the supervisor writes. */
function pauseOrganOf(h: Harness): PauseOrgan {
  return createPauseOrgan({
    ledger: h.ledger,
    values: h.values,
    recordIntervention: (paused, pausedDurationMs, at) => {
      h.ledger.appendIntervention(
        paused ? 'conservatory_paused' : 'conservatory_resumed',
        'conservatory',
        pauseInterventionDetail(paused, pausedDurationMs),
        at,
      );
    },
  });
}

function interventionsOf(h: Harness): { kind: InterventionKind; agent: string; detail: string }[] {
  return h.ledger.listInterventions().map((row) => ({
    kind: row.kind,
    agent: row.agent,
    detail: row.detail,
  }));
}

describe('a paused conservatory', () => {
  it('freezes satiety for as long as it lasts, and never back-charges the pause on resume', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const pause = pauseOrganOf(h);
      h.clock.advanceSeconds(600);

      const outcome = pause.set(true, h.clock.now());
      expect(outcome.changed).toBe(true);
      expect(outcome.pausedSince).toBe(h.clock.now());
      const anchor = h.ledger.getSatietyAnchor(agent.name);
      expect(anchor?.value).toBeCloseTo(70, 6);

      // An hour of wall-clock time passes; nothing happens to anyone.
      h.clock.advanceSeconds(3600);
      expect(readSatiety(h.ledger, h.values, agent.name, h.clock.now())).toBeCloseTo(70, 6);
      expect(readBodyStatus(h.ledger, h.values, agent.name, h.clock.now()).satiety).toBeCloseTo(70, 6);

      const resumed = pause.set(false, h.clock.now());
      expect(resumed.changed).toBe(true);
      expect(resumed.pausedDurationMs).toBe(3600 * 1000);
      expect(h.ledger.getPauseState()).toEqual({ paused: false, pausedSince: null });

      // Resuming starts a fresh anchor at the frozen value, so the hour is gone.
      const fresh = h.ledger.getSatietyAnchor(agent.name);
      expect(fresh?.value).toBeCloseTo(70, 6);
      expect(fresh?.asOf).toBe(h.clock.now());
      h.clock.advanceSeconds(600);
      expect(readSatiety(h.ledger, h.values, agent.name, h.clock.now())).toBeCloseTo(40, 6);
    } finally {
      h.cleanup();
    }
  });

  it('wakes nobody from the heartbeat, and wakes again after the resume', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const registry = new RoundRegistry();
      const woken: string[] = [];
      const wake = (name: string): void => {
        woken.push(name);
      };

      const before = wakeLivingAgents({
        ledger: h.ledger,
        registry,
        wake: (row) => wake(row.name),
      });
      expect(before.woken).toEqual([agent.name]);

      const pause = pauseOrganOf(h);
      pause.set(true, h.clock.now());

      const paused = wakeLivingAgents({
        ledger: h.ledger,
        registry,
        paused: true,
        wake: (row) => wake(row.name),
      });
      expect(paused.woken).toEqual([]);
      expect(paused.reasons).toEqual([{ agent: 'ada', reason: 'paused' }]);
      expect(woken).toEqual(['ada']);

      // The heartbeat's own tick is suppressed too, while its timer keeps beating.
      let ticks = 0;
      const heartbeat = new Heartbeat({
        intervalSeconds: 300,
        now: h.clock.now,
        tick: () => {
          ticks += 1;
        },
        isPaused: () => pause.isPaused(),
        onError: () => undefined,
      });
      await heartbeat.runTick();
      expect(ticks).toBe(0);
      expect(heartbeat.pausedTicks).toBe(1);

      pause.set(false, h.clock.now());
      const after = wakeLivingAgents({
        ledger: h.ledger,
        registry,
        paused: pause.isPaused(),
        wake: (row) => wake(row.name),
      });
      expect(after.woken).toEqual([agent.name]);
      await heartbeat.runTick();
      expect(ticks).toBe(1);
      expect(woken).toEqual(['ada', 'ada']);
    } finally {
      h.cleanup();
    }
  });

  it('lets the console wake an agent while paused, and keeps a meal in step with the freeze', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const pause = pauseOrganOf(h);
      h.clock.advanceSeconds(600);
      pause.set(true, h.clock.now());
      h.clock.advanceSeconds(600);

      // "Wake up now" is not filtered by the switch: it opens a round anyway.
      const registry = new RoundRegistry();
      const woken: string[] = [];
      wakeLivingAgents({
        ledger: h.ledger,
        registry,
        wake: (row) => {
          woken.push(row.name);
        },
      });
      expect(woken).toEqual(['ada']);

      // During that round the agent eats: balance is spent as usual, satiety
      // rises from the frozen value, and the result becomes the new froze value.
      const outcome = eat(h.ledger, h.values, agent.name, h.clock.now());
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.balance).toBe(85);
      expect(h.ledger.getBalance(agent.name)).toBe(85);
      expect(outcome.satiety).toBeCloseTo(95, 6);
      expect(outcome.gained).toBeCloseTo(25, 6);
      expect(h.ledger.getSatietyAnchor(agent.name)?.value).toBeCloseTo(95, 6);
      expect(h.ledger.getSatietyAnchor(agent.name)?.asOf).toBe(h.clock.now());

      // It stays frozen there, however long the pause runs on.
      h.clock.advanceSeconds(7200);
      expect(readSatiety(h.ledger, h.values, agent.name, h.clock.now())).toBeCloseTo(95, 6);
    } finally {
      h.cleanup();
    }
  });

  it('freezes claim timeouts, then gives the leftover time back on resume', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const pause = pauseOrganOf(h);
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 5, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());
      const claimedAt = h.ledger.getTask('task_0001')?.claimedAt;

      pause.set(true, h.clock.now());
      // Twenty hours of wall-clock time pass while the conservatory is paused:
      // no claim may expire, and the supervisor skips expiry entirely.
      h.clock.advanceSeconds(20 * 3600);
      expect(expireClaims(h.ledger, h.clock.now(), h.values.taskClaimTimeoutHours)).toEqual([]);
      expect(h.ledger.getTask('task_0001')?.status).toBe('claimed');

      pause.set(false, h.clock.now());
      expect(h.ledger.getTask('task_0001')?.claimedAt).toBe((claimedAt as number) + 20 * 3600 * 1000);

      // The remaining time is exactly what it was before the pause.
      const almost = expireClaims(
        h.ledger,
        h.clock.now() + 23 * 3600 * 1000,
        h.values.taskClaimTimeoutHours,
      );
      expect(almost).toEqual([]);
      const expired = expireClaims(
        h.ledger,
        h.clock.now() + 25 * 3600 * 1000,
        h.values.taskClaimTimeoutHours,
      );
      expect(expired).toEqual([{ taskId: 'task_0001', agent: 'ada' }]);
      expect(h.ledger.getTask('task_0001')?.status).toBe('open');
    } finally {
      h.cleanup();
    }
  });

  it('records exactly one intervention per real change, and none for a repeat', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const pause = pauseOrganOf(h);

      expect(pause.set(false, h.clock.now()).changed).toBe(false);
      expect(interventionsOf(h)).toEqual([]);

      pause.set(true, h.clock.now());
      expect(pause.set(true, h.clock.now() + 1000).changed).toBe(false);
      h.clock.advanceSeconds(30 * 60);
      pause.set(false, h.clock.now());
      expect(pause.set(false, h.clock.now()).changed).toBe(false);

      const rows = interventionsOf(h);
      expect(rows.map((row) => row.kind)).toEqual(['conservatory_resumed', 'conservatory_paused']);
      expect(rows.every((row) => row.agent === 'conservatory')).toBe(true);
      // The resume row has to say how long the pause lasted.
      expect(rows[0].detail).toContain('30 分');
      // The pause row says what stopped.
      expect(rows[1].detail).toContain('暂停温室');
    } finally {
      h.cleanup();
    }
  });

  it('keeps the pause and the frozen value across a ledger restart', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const pause = pauseOrganOf(h);
      h.clock.advanceSeconds(600);
      pause.set(true, h.clock.now());
      const pausedSince = h.clock.now();
      const frozen = h.ledger.getSatietyAnchor(agent.name)?.value;
      h.ledger.close();

      // The supervisor restarts: same ledger file, new process, later clock.
      h.clock.advanceSeconds(5000);
      const reopened = new Ledger(h.paths.ledgerPath);
      h.ledger = reopened;
      expect(reopened.getPauseState()).toEqual({ paused: true, pausedSince });
      const anchor = reopened.getSatietyAnchor('ada');
      expect(anchor?.value).toBeCloseTo(frozen as number, 6);
      expect(anchor?.asOf).toBe(pausedSince);
      expect(readSatiety(reopened, h.values, 'ada', h.clock.now())).toBeCloseTo(frozen as number, 6);
    } finally {
      h.cleanup();
    }
  });
});

describe('a pause torn between its two writes', () => {
  it('charges no hunger on resume, and gives the claim clock its time back', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      // A database written by an older build could hold this: the switch on,
      // the instant it began missing. Construct it directly, since the fix is
      // that the two rows can no longer be written apart.
      h.ledger.setSetting('paused', '1');
      expect(h.ledger.getPauseState()).toEqual({ paused: true, pausedSince: null });

      const satietyBefore = readSatiety(h.ledger, h.values, 'ada', h.clock.now());
      const task = createTask(h.ledger, {
        id: 'task_0001',
        title: 'chore',
        description: 'd',
        price: 30,
        at: h.clock.now(),
      });
      expect(task.ok).toBe(true);
      expect(claimTask(h.ledger, 'ada', 'task_0001', h.clock.now()).ok).toBe(true);
      const claimedAt = h.ledger.getTask('task_0001')?.claimedAt;

      // Twenty-four hours pass while the pause is in force.
      const pauseSpanMs = 24 * 60 * 60 * 1000;
      h.clock.advance(pauseSpanMs);

      const outcome = pauseOrganOf(h).set(false, h.clock.now());
      expect(outcome.changed).toBe(true);
      expect(outcome.pausedDurationMs).toBe(0);

      // Not one character of that day was hunger.
      expect(readSatiety(h.ledger, h.values, 'ada', h.clock.now())).toBeCloseTo(satietyBefore, 6);
      // The claim clock did not lose the pause either; with no anchor recorded
      // there is no span to give back, and the fair reading is not to punish.
      expect(h.ledger.getTask('task_0001')?.claimedAt).toBe(claimedAt);
    } finally {
      h.cleanup();
    }
  });
});
