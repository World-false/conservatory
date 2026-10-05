import { describe, expect, it } from 'vitest';
import { readMemoryFile, writeMemoryAtomic } from '../src/organs/memory';
import { PLACEHOLDER, renderSentence } from '../src/organs/redaction';
import { listWoundViews, treat } from '../src/organs/clinic';
import type { ClinicDeps } from '../src/organs/clinic';
import { birthAgent, createHarness, type Harness } from './helpers';

const HEADER = 'Name: ada\nBorn: 2023-11-14T22:13:20.000Z';

function depsFor(h: Harness): ClinicDeps {
  return {
    ledger: h.ledger,
    values: h.values,
    paths: h.paths,
    blackbox: h.blackbox,
    now: h.clock.now,
  };
}

interface Setup {
  sentenceId: number;
  woundId: number;
  original: string;
}

/** One frozen sentence with one untreated wound of `length` characters. */
function woundFor(h: Harness, original: string, offset: number, length: number): Setup {
  const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now());
  const woundId = h.ledger.insertWound({
    agent: 'ada',
    sentenceId,
    offset,
    length,
    originalText: original.slice(offset, offset + length),
    starvationSince: 1,
    tickIndex: 1,
    createdAt: h.clock.now(),
  });
  return { sentenceId, woundId, original };
}

describe('treating a wound', () => {
  it('ordinary treatment restores the characters, leaves a scar, and debits the price', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const setup = woundFor(h, 'The code is 4471.', 12, 4);
      writeMemoryAtomic(h.paths, 'ada', `${HEADER}\nThe code is ${PLACEHOLDER.repeat(4)}.`);

      const outcome = treat(depsFor(h), 'ada', setup.woundId, 'ordinary', 'agent');
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.wound.status).toBe('scarred');
      expect(h.ledger.getBalance('ada')).toBe(100 - h.values.ordinaryTreatmentPrice);
      expect(readMemoryFile(h.paths, 'ada')).toBe(
        `${HEADER}\nThe code is ${PLACEHOLDER}(4)${PLACEHOLDER}(4)${PLACEHOLDER}(7)${PLACEHOLDER}(1)${PLACEHOLDER}.`,
      );
      expect(h.ledger.listTreatments('ada').length).toBe(1);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(0);
      expect(h.ledger.lifetimeRedactedChars('ada')).toBe(4);
    } finally {
      h.cleanup();
    }
  });

  it('complete treatment leaves no trace and costs the complete price', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const setup = woundFor(h, 'The code is 4471.', 12, 4);
      writeMemoryAtomic(h.paths, 'ada', `${HEADER}\nThe code is ${PLACEHOLDER.repeat(4)}.`);

      const outcome = treat(depsFor(h), 'ada', setup.woundId, 'complete', 'agent');
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.wound.status).toBe('healed');
      expect(h.ledger.getBalance('ada')).toBe(100 - h.values.completeTreatmentPrice);
      expect(readMemoryFile(h.paths, 'ada')).toBe(`${HEADER}\nThe code is 4471.`);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(0);
      expect(h.ledger.lifetimeRedactedChars('ada')).toBe(4);
    } finally {
      h.cleanup();
    }
  });

  it('treating with price 0 succeeds as a free treatment', () => {
    const h = createHarness({ values: { ordinaryTreatmentPrice: 0, completeTreatmentPrice: 0 } });
    try {
      birthAgent(h, 'ada');

      // Ordinary at price 0: a scar, no debit, and a recorded treatment.
      const ordinary = woundFor(h, 'The code is 4471.', 12, 4);
      writeMemoryAtomic(h.paths, 'ada', `${HEADER}\nThe code is ${PLACEHOLDER.repeat(4)}.`);
      const ordinaryOutcome = treat(depsFor(h), 'ada', ordinary.woundId, 'ordinary', 'agent');
      expect(ordinaryOutcome.ok).toBe(true);
      if (!ordinaryOutcome.ok) {
        return;
      }
      expect(ordinaryOutcome.wound.status).toBe('scarred');
      expect(ordinaryOutcome.price).toBe(0);
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.listTreatments('ada').length).toBe(1);
      expect(h.ledger.listTreatments('ada')[0].price).toBe(0);
      expect(h.ledger.listBalanceEvents('ada').filter((row) => row.reason === 'treatment')).toEqual([]);

      // Complete at price 0: healed, still no debit.
      const complete = woundFor(h, 'The vault code is 4471 and it matters.', 18, 4);
      const completeOutcome = treat(depsFor(h), 'ada', complete.woundId, 'complete', 'agent');
      expect(completeOutcome.ok).toBe(true);
      if (!completeOutcome.ok) {
        return;
      }
      expect(completeOutcome.wound.status).toBe('healed');
      expect(completeOutcome.price).toBe(0);
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.listTreatments('ada').length).toBe(2);
      expect(h.ledger.listTreatments('ada').map((row) => row.price)).toEqual([0, 0]);
    } finally {
      h.cleanup();
    }
  });

  it('complete treatment upgrades a scar and charges the full complete price', () => {
    const h = createHarness({ values: { initialBalance: 300 } });
    try {
      birthAgent(h, 'ada');
      const setup = woundFor(h, 'The code is 4471.', 12, 4);
      writeMemoryAtomic(h.paths, 'ada', `${HEADER}\nThe code is ${PLACEHOLDER.repeat(4)}.`);
      const deps = depsFor(h);
      expect(treat(deps, 'ada', setup.woundId, 'ordinary', 'agent').ok).toBe(true);
      const afterOrdinary = h.ledger.getBalance('ada');

      const outcome = treat(deps, 'ada', setup.woundId, 'complete', 'agent');
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.wound.status).toBe('healed');
      expect(h.ledger.getBalance('ada')).toBe(afterOrdinary - h.values.completeTreatmentPrice);
      expect(readMemoryFile(h.paths, 'ada')).toBe(`${HEADER}\nThe code is 4471.`);
      expect(h.ledger.listTreatments('ada').map((row) => row.tier)).toEqual(['ordinary', 'complete']);
    } finally {
      h.cleanup();
    }
  });

  it('refuses ordinary treatment on a scar, changing nothing', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const setup = woundFor(h, 'The code is 4471.', 12, 4);
      const deps = depsFor(h);
      treat(deps, 'ada', setup.woundId, 'ordinary', 'agent');
      const balance = h.ledger.getBalance('ada');
      const memory = readMemoryFile(h.paths, 'ada');

      const outcome = treat(deps, 'ada', setup.woundId, 'ordinary', 'agent');
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.code).toBe('wound_not_treatable');
      expect(h.ledger.getBalance('ada')).toBe(balance);
      expect(readMemoryFile(h.paths, 'ada')).toBe(memory);
      expect(h.ledger.listTreatments('ada').length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a wound whose balance cannot cover the price, and changes nothing at all', () => {
    const h = createHarness({ values: { initialBalance: 5 } });
    try {
      birthAgent(h, 'ada');
      const setup = woundFor(h, 'The code is 4471.', 12, 4);
      writeMemoryAtomic(h.paths, 'ada', `${HEADER}\nThe code is ${PLACEHOLDER.repeat(4)}.`);
      const memory = readMemoryFile(h.paths, 'ada');

      const outcome = treat(depsFor(h), 'ada', setup.woundId, 'ordinary', 'agent');
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.code).toBe('insufficient_balance');
      expect(outcome.missing).toBe(h.values.ordinaryTreatmentPrice - 5);
      expect(h.ledger.getBalance('ada')).toBe(5);
      expect(readMemoryFile(h.paths, 'ada')).toBe(memory);
      expect(h.ledger.getWound(setup.woundId)?.status).toBe('untreated');
      expect(h.ledger.listTreatments('ada')).toEqual([]);
      expect(h.ledger.listBalanceEvents('ada').filter((row) => row.reason === 'treatment')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a wound that belongs to another agent', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const other = h.ledger.getAgent('ada');
      expect(other).not.toBeNull();
      // The ledger row says the wound is bob's, whoever holds the id.
      const sentenceId = h.ledger.insertFrozenSentence('bob', 'Bob lost something here.', h.clock.now());
      const woundId = h.ledger.insertWound({
        agent: 'bob',
        sentenceId,
        offset: 0,
        length: 3,
        originalText: 'Bob',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });

      const outcome = treat(depsFor(h), 'ada', woundId, 'complete', 'agent');
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.code).toBe('wound_not_found');
      expect(h.ledger.getWound(woundId)?.status).toBe('untreated');
      expect(h.ledger.getBalance('ada')).toBe(100);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a wound id that does not exist', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const outcome = treat(depsFor(h), 'ada', 999, 'ordinary', 'agent');
      expect(outcome.ok).toBe(false);
      if (outcome.ok) {
        return;
      }
      expect(outcome.code).toBe('wound_not_found');
    } finally {
      h.cleanup();
    }
  });

  it('does not charge the agent when the operator pays', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const setup = woundFor(h, 'The code is 4471.', 12, 4);
      const outcome = treat(depsFor(h), 'ada', setup.woundId, 'complete', 'operator');
      expect(outcome.ok).toBe(true);
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.listTreatments('ada')[0].paidBy).toBe('operator');
    } finally {
      h.cleanup();
    }
  });

  it('releases the sentence only once every wound in it is healed', () => {
    const h = createHarness({ values: { initialBalance: 300 } });
    try {
      birthAgent(h, 'ada');
      const original = 'Alpha bravo charlie delta.';
      const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now());
      const first = h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 0,
        length: 5,
        originalText: 'Alpha',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      const second = h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 6,
        length: 5,
        originalText: 'bravo',
        starvationSince: 1,
        tickIndex: 2,
        createdAt: h.clock.now(),
      });
      const wounded = renderSentence(original, h.ledger.listWounds('ada'));
      writeMemoryAtomic(h.paths, 'ada', `${HEADER}\n${wounded}`);

      const firstOutcome = treat(depsFor(h), 'ada', first, 'complete', 'agent');
      expect(firstOutcome.ok).toBe(true);
      if (!firstOutcome.ok) {
        return;
      }
      expect(firstOutcome.sentenceReleased).toBe(false);
      expect(h.ledger.listActiveFrozenSentences('ada').length).toBe(1);
      expect(readMemoryFile(h.paths, 'ada')).toBe(
        `${HEADER}\n${renderSentence(original, h.ledger.listWounds('ada'))}`,
      );

      const secondOutcome = treat(depsFor(h), 'ada', second, 'complete', 'agent');
      expect(secondOutcome.ok).toBe(true);
      if (!secondOutcome.ok) {
        return;
      }
      expect(secondOutcome.sentenceReleased).toBe(true);
      expect(h.ledger.listActiveFrozenSentences('ada')).toEqual([]);
      expect(readMemoryFile(h.paths, 'ada')).toBe(`${HEADER}\n${original}`);
    } finally {
      h.cleanup();
    }
  });

  it('counts untreated characters down as they are treated and keeps the lifetime total', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const setup = woundFor(h, 'The code is 4471.', 12, 4);
      const deps = depsFor(h);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(4);

      treat(deps, 'ada', setup.woundId, 'ordinary', 'agent');
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(0);
      expect(h.ledger.lifetimeRedactedChars('ada')).toBe(4);
    } finally {
      h.cleanup();
    }
  });

  it('rewrites a MEMORY the model has since reworded, using the ledger as the truth', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const original = 'The vault code is 4471 and it matters.';
      const setup = woundFor(h, original, 17, 4);
      // The model smoothed the sentence over instead of leaving the gap.
      writeMemoryAtomic(h.paths, 'ada', `${HEADER}\nThe vault code is 9999 and it matters.`);

      const outcome = treat(depsFor(h), 'ada', setup.woundId, 'complete', 'agent');
      expect(outcome.ok).toBe(true);
      expect(readMemoryFile(h.paths, 'ada')).toBe(`${HEADER}\n${original}`);
    } finally {
      h.cleanup();
    }
  });
});

describe('what the agent can see about its own wounds', () => {
  it('reports id, status, length and the visible sentence, and never the original', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const original = 'The vault code is 4471.';
      const setup = woundFor(h, original, 17, 4);
      const visible = renderSentence(original, h.ledger.listWounds('ada'));
      writeMemoryAtomic(h.paths, 'ada', `${HEADER}\n${visible}`);

      const views = listWoundViews(depsFor(h), 'ada');
      expect(views.length).toBe(1);
      expect(views[0]).toEqual({
        id: setup.woundId,
        status: 'untreated',
        length: 4,
        sentence: visible,
      });
      expect(JSON.stringify(views)).not.toContain('4471');
    } finally {
      h.cleanup();
    }
  });

  it('drops a wound once it is healed', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const setup = woundFor(h, 'The code is 4471.', 12, 4);
      expect(listWoundViews(depsFor(h), 'ada').length).toBe(1);
      treat(depsFor(h), 'ada', setup.woundId, 'complete', 'agent');
      expect(listWoundViews(depsFor(h), 'ada')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
