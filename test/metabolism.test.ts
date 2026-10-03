import { describe, expect, it } from 'vitest';
import { computeSatiety, eat, formatAmount, grantSatiety, readBodyStatus } from '../src/organs/metabolism';
import { birthAgent, createHarness } from './helpers';

describe('satiety', () => {
  it('falls with wall-clock seconds and never goes below zero', () => {
    expect(computeSatiety({ value: 100, asOf: 0 }, 0, 0.05)).toBe(100);
    expect(computeSatiety({ value: 100, asOf: 0 }, 60_000, 0.05)).toBeCloseTo(97, 6);
    expect(computeSatiety({ value: 100, asOf: 0 }, 3_600_000, 0.05)).toBe(0);
    expect(computeSatiety({ value: 3, asOf: 0 }, 3_600_000, 0.05)).toBe(0);
  });

  it('ignores time running backwards', () => {
    expect(computeSatiety({ value: 42, asOf: 5_000 }, 1_000, 0.05)).toBe(42);
  });

  it('is read from the anchor on every call, without writing anything', () => {
    const h = createHarness();
    const agent = birthAgent(h);
    h.clock.advanceSeconds(600);
    expect(readBodyStatus(h.ledger, h.values, agent.name, h.clock.now()).satiety).toBeCloseTo(70, 6);
    expect(h.ledger.getSatietyAnchor(agent.name)?.value).toBe(100);
  });
});

describe('eating', () => {
  it('caps at the ceiling and reports exactly what was wasted', () => {
    const h = createHarness();
    const agent = birthAgent(h);
    h.ledger.setSatietyAnchor(agent.name, 90, h.clock.now());

    const outcome = eat(h.ledger, h.values, agent.name, h.clock.now());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.satiety).toBe(100);
    expect(outcome.gained).toBe(10);
    expect(outcome.overflow).toBe(15);
    expect(outcome.balance).toBe(85);
    expect(h.ledger.getBalance(agent.name)).toBe(85);
    expect(h.ledger.getSatietyAnchor(agent.name)?.value).toBe(100);
  });

  it('buys a full meal when there is room for it', () => {
    const h = createHarness();
    const agent = birthAgent(h);
    h.clock.advanceSeconds(1000);
    const before = readBodyStatus(h.ledger, h.values, agent.name, h.clock.now()).satiety;
    const outcome = eat(h.ledger, h.values, agent.name, h.clock.now());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.gained).toBe(25);
    expect(outcome.overflow).toBe(0);
    expect(outcome.satiety).toBeCloseTo(before + 25, 6);
  });

  it('writes a new anchor, so the meal decays from the moment it was eaten', () => {
    const h = createHarness();
    const agent = birthAgent(h);
    eat(h.ledger, h.values, agent.name, h.clock.now());
    h.clock.advanceSeconds(100);
    expect(readBodyStatus(h.ledger, h.values, agent.name, h.clock.now()).satiety).toBeCloseTo(95, 6);
  });
});

describe('a balance that cannot pay', () => {
  it('refuses the meal and changes neither number', () => {
    const h = createHarness();
    const agent = birthAgent(h);
    h.clock.advanceSeconds(200);
    const satietyBefore = readBodyStatus(h.ledger, h.values, agent.name, h.clock.now()).satiety;
    // Spend down to below one meal by hand, then try to eat.
    h.ledger.appendBalanceEvent(agent.name, -90, 'test_setup', null, h.clock.now());
    expect(h.ledger.getBalance(agent.name)).toBe(10);
    const eventsBefore = h.ledger.listBalanceEvents(agent.name).length;

    const outcome = eat(h.ledger, h.values, agent.name, h.clock.now());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('insufficient_balance');
    expect(outcome.missing).toBe(5);
    expect(h.ledger.getBalance(agent.name)).toBe(10);
    expect(h.ledger.listBalanceEvents(agent.name).length).toBe(eventsBefore);
    expect(readBodyStatus(h.ledger, h.values, agent.name, h.clock.now()).satiety).toBeCloseTo(
      satietyBefore,
      6,
    );
  });

  it('never lets a debit push the balance below zero', () => {
    const h = createHarness();
    const agent = birthAgent(h);
    expect(h.ledger.debitIfAffordable(agent.name, 101, 'test', null, h.clock.now())).toBe(false);
    expect(h.ledger.getBalance(agent.name)).toBe(100);
    expect(h.ledger.debitIfAffordable(agent.name, 100, 'test', null, h.clock.now())).toBe(true);
    expect(h.ledger.getBalance(agent.name)).toBe(0);
    expect(h.ledger.debitIfAffordable(agent.name, 1, 'test', null, h.clock.now())).toBe(false);
    expect(h.ledger.getBalance(agent.name)).toBe(0);
  });
});

describe('operator satiety grants', () => {
  it('are capped like a meal and never refill on their own', () => {
    const h = createHarness();
    const agent = birthAgent(h);
    h.clock.advanceSeconds(100);
    const next = grantSatiety(h.ledger, h.values, agent.name, 1000, h.clock.now());
    expect(next).toBe(100);
    h.clock.advanceSeconds(100);
    expect(readBodyStatus(h.ledger, h.values, agent.name, h.clock.now()).satiety).toBeCloseTo(95, 6);
  });
});

describe('number formatting for the agent', () => {
  it('keeps a short, readable form', () => {
    expect(formatAmount(87.30000000001)).toBe('87.3');
    expect(formatAmount(100)).toBe('100');
  });
});
