import { afterEach, describe, expect, it, vi } from 'vitest';
import { Heartbeat } from '../src/organs/heartbeat';
import { RoundRegistry, wakeLivingAgents } from '../src/organs/population';
import { claimTask, createTask, expireClaims } from '../src/organs/taskboard';
import { birthAgent, createHarness, insertAgentRow } from './helpers';

afterEach(() => {
  vi.useRealTimers();
});

describe('waking the living', () => {
  it('skips an agent that is already in a round', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertAgentRow(h, 'bob');
      const registry = new RoundRegistry();
      registry.markStarted('ada');
      const woken: string[] = [];

      const report = wakeLivingAgents({
        ledger: h.ledger,
        registry,
        wake: (agent) => {
          woken.push(agent.name);
        },
      });

      expect(report.skipped).toEqual(['ada']);
      expect(report.woken).toEqual(['bob']);
      expect(woken).toEqual(['bob']);
      expect(registry.isBusy('ada')).toBe(true);
      expect(registry.busyAgents()).toEqual(['ada']);
    } finally {
      h.cleanup();
    }
  });

  it('ignores an agent that is not alive', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      h.ledger.createAgent({ name: 'ghost', bornAt: h.clock.now(), model: 'm', status: 'dead' });
      const registry = new RoundRegistry();
      const woken: string[] = [];
      wakeLivingAgents({
        ledger: h.ledger,
        registry,
        wake: (agent) => {
          woken.push(agent.name);
        },
      });
      expect(woken).toEqual(['ada']);
    } finally {
      h.cleanup();
    }
  });
});

describe('the heartbeat timer', () => {
  it('fires once per configured interval', async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const heartbeat = new Heartbeat({
      intervalSeconds: 300,
      now: () => Date.now(),
      tick: () => {
        ticks += 1;
      },
      onError: () => undefined,
    });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(ticks).toBe(3);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(ticks).toBe(3);
    expect(heartbeat.isRunning).toBe(false);
  });

  it('skips a tick that is still running instead of stacking rounds', async () => {
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    const heartbeat = new Heartbeat({
      intervalSeconds: 1,
      now: () => Date.now(),
      tick: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      onError: () => undefined,
    });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(heartbeat.skippedTicks).toBe(2);
    if (release !== null) {
      const done = release as () => void;
      done();
    }
    await vi.advanceTimersByTimeAsync(0);
    heartbeat.stop();
  });

  it('reports a failing tick instead of letting it kill the supervisor', async () => {
    const errors: unknown[] = [];
    const heartbeat = new Heartbeat({
      intervalSeconds: 300,
      now: () => 0,
      tick: () => {
        throw new Error('boom');
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    await heartbeat.runTick();
    expect(errors.length).toBe(1);
    expect(heartbeat.lastTickAt).toBe(0);
  });
});

describe('the heartbeat tick of the supervisor', () => {
  it('returns an expired claim to the board and then wakes the living', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const registry = new RoundRegistry();
      createTask(h.ledger, { id: 'task_0001', title: 'Work', description: 'Do it.', price: 5, at: h.clock.now() });
      claimTask(h.ledger, 'ada', 'task_0001', h.clock.now());

      const later = h.clock.now() + 25 * 3600 * 1000;
      const expired = expireClaims(h.ledger, later, h.values.taskClaimTimeoutHours);
      expect(expired.map((claim) => claim.taskId)).toEqual(['task_0001']);
      expect(h.ledger.getTask('task_0001')?.status).toBe('open');

      const woken: string[] = [];
      wakeLivingAgents({
        ledger: h.ledger,
        registry,
        wake: (agent) => {
          woken.push(agent.name);
        },
      });
      expect(woken).toEqual(['ada']);
    } finally {
      h.cleanup();
    }
  });
});
