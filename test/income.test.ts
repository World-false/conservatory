import { describe, expect, it } from 'vitest';
import { rejectIncome, reportIncome, verifyIncome } from '../src/organs/income';
import { birthAgent, createHarness } from './helpers';

describe('income reports', () => {
  it('stores a pending report without touching the balance', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h);
      const balanceBefore = h.ledger.getBalance(agent.name);
      const result = reportIncome(
        h.ledger,
        agent.name,
        { where: 'upwork', work: 'translated a page', amount: 20, currency: 'USD' },
        h.clock.now(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.report.status).toBe('pending');
      expect(h.ledger.getBalance(agent.name)).toBe(balanceBefore);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a report with a missing field or a non-positive amount', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h);
      const missing = reportIncome(
        h.ledger,
        agent.name,
        { where: '', work: 'x', amount: 5, currency: 'USD' },
        h.clock.now(),
      );
      expect(missing.ok).toBe(false);
      const zero = reportIncome(
        h.ledger,
        agent.name,
        { where: 'a', work: 'b', amount: 0, currency: 'USD' },
        h.clock.now(),
      );
      expect(zero.ok).toBe(false);
      expect(h.ledger.listIncomeReports()).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('refuses to credit anything while the exchange rate is unset', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h);
      const reported = reportIncome(
        h.ledger,
        agent.name,
        { where: 'upwork', work: 'translated a page', amount: 20, currency: 'USD' },
        h.clock.now(),
      );
      if (!reported.ok) {
        throw new Error('the report should have been accepted');
      }
      const balanceBefore = h.ledger.getBalance(agent.name);

      const verified = verifyIncome(h.ledger, reported.report.id, 20, null, h.clock.now());
      expect(verified.ok).toBe(false);
      if (verified.ok) {
        return;
      }
      expect(verified.code).toBe('exchange_rate_unset');
      expect(h.ledger.getBalance(agent.name)).toBe(balanceBefore);
      expect(h.ledger.getIncomeReport(reported.report.id)?.status).toBe('pending');
    } finally {
      h.cleanup();
    }
  });

  it('credits the verified amount times the rate, exactly once', () => {
    const h = createHarness({ values: { exchangeRate: 7.5 } });
    try {
      const agent = birthAgent(h);
      const reported = reportIncome(
        h.ledger,
        agent.name,
        { where: 'upwork', work: 'translated a page', amount: 20, currency: 'USD' },
        h.clock.now(),
      );
      if (!reported.ok) {
        throw new Error('the report should have been accepted');
      }
      const balanceBefore = h.ledger.getBalance(agent.name);

      const verified = verifyIncome(h.ledger, reported.report.id, 12.5, h.values.exchangeRate, h.clock.now());
      expect(verified.ok).toBe(true);
      if (!verified.ok) {
        return;
      }
      expect(verified.credited).toBeCloseTo(12.5 * 7.5, 9);
      expect(h.ledger.getBalance(agent.name)).toBeCloseTo(balanceBefore + 12.5 * 7.5, 9);
      expect(verified.report.status).toBe('credited');
      expect(verified.report.verifiedAmount).toBe(12.5);
      expect(verified.report.exchangeRate).toBe(7.5);

      const again = verifyIncome(h.ledger, reported.report.id, 12.5, h.values.exchangeRate, h.clock.now());
      expect(again.ok).toBe(false);
      if (again.ok) {
        return;
      }
      expect(again.code).toBe('report_not_pending');
      expect(h.ledger.getBalance(agent.name)).toBeCloseTo(balanceBefore + 12.5 * 7.5, 9);
      expect(h.ledger.listBalanceEvents(agent.name).filter((e) => e.reason === 'income_credit').length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('refuses to credit a report whose agent has died', () => {
    const h = createHarness({ values: { exchangeRate: 2 } });
    try {
      const agent = birthAgent(h);
      const reported = reportIncome(
        h.ledger,
        agent.name,
        { where: 'upwork', work: 'translated a page', amount: 20, currency: 'USD' },
        h.clock.now(),
      );
      if (!reported.ok) {
        throw new Error('the report should have been accepted');
      }
      const balanceBefore = h.ledger.getBalance(agent.name);
      expect(h.ledger.markAgentDead(agent.name)).toBe(true);

      const result = verifyIncome(h.ledger, reported.report.id, 10, 2, h.clock.now());
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe('reporter_not_alive');
      expect(h.ledger.getBalance(agent.name)).toBe(balanceBefore);
      expect(h.ledger.getIncomeReport(reported.report.id)?.status).toBe('pending');
    } finally {
      h.cleanup();
    }
  });

  it('refuses a negative verified amount', () => {
    const h = createHarness({ values: { exchangeRate: 2 } });
    try {
      const agent = birthAgent(h);
      const reported = reportIncome(
        h.ledger,
        agent.name,
        { where: 'a', work: 'b', amount: 5, currency: 'USD' },
        h.clock.now(),
      );
      if (!reported.ok) {
        throw new Error('the report should have been accepted');
      }
      const result = verifyIncome(h.ledger, reported.report.id, -1, 2, h.clock.now());
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe('invalid_amount');
      expect(h.ledger.getBalance(agent.name)).toBe(100);
    } finally {
      h.cleanup();
    }
  });

  it('rejects a report without paying, once', () => {
    const h = createHarness({ values: { exchangeRate: 3 } });
    try {
      const agent = birthAgent(h);
      const reported = reportIncome(
        h.ledger,
        agent.name,
        { where: 'a', work: 'b', amount: 5, currency: 'USD' },
        h.clock.now(),
      );
      if (!reported.ok) {
        throw new Error('the report should have been accepted');
      }
      const rejected = rejectIncome(h.ledger, reported.report.id, h.clock.now());
      expect(rejected.ok).toBe(true);
      expect(h.ledger.getBalance(agent.name)).toBe(100);
      const again = rejectIncome(h.ledger, reported.report.id, h.clock.now());
      expect(again.ok).toBe(false);
      const verifyAfterReject = verifyIncome(h.ledger, reported.report.id, 5, 3, h.clock.now());
      expect(verifyAfterReject.ok).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('reports a missing report', () => {
    const h = createHarness({ values: { exchangeRate: 1 } });
    try {
      birthAgent(h);
      const result = verifyIncome(h.ledger, 999, 10, 1, h.clock.now());
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.code).toBe('report_not_found');
    } finally {
      h.cleanup();
    }
  });
});
