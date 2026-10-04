import { describe, expect, it } from 'vitest';
import { AgentRecord } from '../src/organs/ledger';
import { createAgent, effectiveMaxSlots, listLivingOtherAgents, listSlots } from '../src/organs/population';
import { birthAgent, createHarness, type Harness } from './helpers';

const FOUR_SLOTS = { maxSlots: 4 } as const;

function tryBirth(h: Harness, name: string): ReturnType<typeof createAgent> {
  return createAgent({
    name,
    model: 'test-model',
    now: h.clock.now(),
    ledger: h.ledger,
    values: h.values,
    paths: h.paths,
  });
}

/** Names of the agents the ledger currently calls alive, in birth order. */
function livingNames(h: Harness): string[] {
  return h.ledger
    .listAgents()
    .filter((agent) => agent.status === 'alive')
    .map((agent) => agent.name);
}

describe('the slot ceiling comes from the configured maxSlots', () => {
  it('no longer clamps the configured count to one', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      expect(effectiveMaxSlots(h.values)).toBe(4);
      expect(listSlots(h.values, h.ledger)).toHaveLength(4);
    } finally {
      h.cleanup();
    }
  });

  it('fills four slots with four living agents', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const names = ['ada', 'bob', 'cleo', 'dana'];
      for (const name of names) {
        const result = birthAgent(h, name);
        expect(result.name).toBe(name);
        expect(result.status).toBe('alive');
      }
      expect(livingNames(h)).toEqual(names);
      expect(listSlots(h.values, h.ledger).map((slot) => slot.agent?.name ?? null)).toEqual(names);
    } finally {
      h.cleanup();
    }
  });

  it('refuses the fifth agent with no_free_slot', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      for (const name of ['ada', 'bob', 'cleo', 'dana']) {
        birthAgent(h, name);
      }
      const fifth = tryBirth(h, 'erin');
      expect(fifth.ok).toBe(false);
      if (fifth.ok) {
        return;
      }
      expect(fifth.code).toBe('no_free_slot');
      expect(h.ledger.getAgent('erin')).toBeNull();
      expect(livingNames(h)).toHaveLength(4);
    } finally {
      h.cleanup();
    }
  });

  it('frees a slot when an agent dies, and the new agent takes it', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      for (const name of ['ada', 'bob', 'cleo', 'dana']) {
        birthAgent(h, name);
      }
      expect(h.ledger.markAgentDead('cleo')).toBe(true);

      const freed = listSlots(h.values, h.ledger);
      expect(freed).toHaveLength(4);
      expect(freed.filter((slot) => slot.agent === null)).toHaveLength(1);
      expect(freed.map((slot) => slot.agent?.name ?? null)).toEqual(['ada', 'bob', 'dana', null]);

      const erin = tryBirth(h, 'erin');
      expect(erin.ok).toBe(true);
      expect(livingNames(h)).toEqual(['ada', 'bob', 'dana', 'erin']);
      expect(listSlots(h.values, h.ledger).map((slot) => slot.agent?.name ?? null)).toEqual([
        'ada',
        'bob',
        'dana',
        'erin',
      ]);
    } finally {
      h.cleanup();
    }
  });

  it('ignores a dead agent when filling slots', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      h.ledger.createAgent({ name: 'ghost', bornAt: h.clock.now(), model: 'm', status: 'dead' });
      // The dead are never neighbours, and a dead agent occupies no slot.
      expect(listLivingOtherAgents(h.ledger).map((agent) => agent.name)).toEqual(['ada']);
      expect(listSlots(h.values, h.ledger).map((slot) => slot.agent?.name ?? null)).toEqual([
        'ada',
        null,
        null,
        null,
      ]);
    } finally {
      h.cleanup();
    }
  });
});

describe('listing the living neighbours', () => {
  it('returns the living, never the asker, and never the dead', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      for (const name of ['ada', 'bob', 'cleo', 'dana']) {
        birthAgent(h, name);
      }
      h.ledger.markAgentDead('dana');

      expect(listLivingOtherAgents(h.ledger, 'ada').map((agent) => agent.name)).toEqual(['bob', 'cleo']);
      expect(listLivingOtherAgents(h.ledger, 'cleo').map((agent) => agent.name)).toEqual(['ada', 'bob']);
      expect(listLivingOtherAgents(h.ledger).map((agent) => agent.name)).toEqual(['ada', 'bob', 'cleo']);
      for (const agent of listLivingOtherAgents(h.ledger, 'ada')) {
        expect(agent.status).toBe('alive');
        expect(agent.name).not.toBe('ada');
      }
    } finally {
      h.cleanup();
    }
  });
});

describe('moving balance between agents', () => {
  it('debits the sender, credits the recipient, and leaves a system notice', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const ada = birthAgent(h, 'ada');
      const bob = birthAgent(h, 'bob');
      const at = h.clock.now() + 1000;
      h.ledger.appendBalanceEvent(ada.name, 40, 'test_funding', null, at);
      const senderBefore = h.ledger.getBalance('ada');
      const recipientBefore = h.ledger.getBalance('bob');

      const result = h.ledger.transferBalance('ada', 'bob', 12.5, at);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.senderBalance).toBe(senderBefore - 12.5);
      expect(result.recipientBalance).toBe(recipientBefore + 12.5);
      expect(h.ledger.getBalance('ada')).toBe(senderBefore - 12.5);
      expect(h.ledger.getBalance('bob')).toBe(recipientBefore + 12.5);

      const out = h.ledger.listBalanceEvents('ada').at(-1);
      expect(out?.reason).toBe('transfer_out');
      expect(out?.delta).toBe(-12.5);
      expect(out?.ref).toBe('bob');
      expect(out?.at).toBe(at);
      const incoming = h.ledger.listBalanceEvents('bob').at(-1);
      expect(incoming?.reason).toBe('transfer_in');
      expect(incoming?.delta).toBe(12.5);
      expect(incoming?.ref).toBe('ada');

      const unread = h.ledger.listUnreadMessages('bob');
      expect(unread).toHaveLength(1);
      expect(unread[0]?.sender).toBe('system');
      expect(unread[0]?.body).toBe('Received 12.5 balance from ada.');
      expect(unread[0]?.at).toBe(at);
      // The sender's own balance move is not announced back to it.
      expect(h.ledger.listUnreadMessages('ada')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('formats whole and fractional amounts without trailing noise', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      const whole = h.ledger.transferBalance('ada', 'bob', 10, h.clock.now());
      const fractional = h.ledger.transferBalance('bob', 'ada', 0.1 + 0.2, h.clock.now());
      expect(whole.ok).toBe(true);
      expect(fractional.ok).toBe(true);
      const bodies = h.ledger.listMessagesForAgent('bob').map((message) => message.body);
      expect(bodies).toContain('Received 10 balance from ada.');
      const back = h.ledger.listMessagesForAgent('ada').map((message) => message.body);
      expect(back).toContain('Received 0.3 balance from bob.');
    } finally {
      h.cleanup();
    }
  });

  it('refuses an unaffordable transfer and writes nothing at all', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      h.ledger.appendBalanceEvent('ada', -95, 'test_setup', null, h.clock.now());
      expect(h.ledger.getBalance('ada')).toBe(5);
      const senderBefore = h.ledger.getBalance('ada');
      const recipientBefore = h.ledger.getBalance('bob');
      const senderEvents = h.ledger.listBalanceEvents('ada').length;
      const recipientEvents = h.ledger.listBalanceEvents('bob').length;
      const messagesBefore = h.ledger.listMessagesForAgent('bob').length;

      const result = h.ledger.transferBalance('ada', 'bob', 5.001, h.clock.now());
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.reason).toBe('insufficient_balance');
      expect(h.ledger.getBalance('ada')).toBe(senderBefore);
      expect(h.ledger.getBalance('bob')).toBe(recipientBefore);
      expect(h.ledger.listBalanceEvents('ada')).toHaveLength(senderEvents);
      expect(h.ledger.listBalanceEvents('bob')).toHaveLength(recipientEvents);
      expect(h.ledger.listMessagesForAgent('bob')).toHaveLength(messagesBefore);
    } finally {
      h.cleanup();
    }
  });

  it('allows spending the balance down to exactly zero, and not a hair past it', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      const exactly = h.ledger.transferBalance('ada', 'bob', 100, h.clock.now());
      expect(exactly.ok).toBe(true);
      expect(h.ledger.getBalance('ada')).toBe(0);
      const past = h.ledger.transferBalance('ada', 'bob', 0.0001, h.clock.now());
      expect(past.ok).toBe(false);
      if (past.ok) {
        return;
      }
      expect(past.reason).toBe('insufficient_balance');
      expect(h.ledger.getBalance('ada')).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('the edges of a transfer are refused without a trace', () => {
  it('refuses a transfer to oneself', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      const events = h.ledger.listBalanceEvents('ada').length;
      const result = h.ledger.transferBalance('ada', 'ada', 10, h.clock.now());
      expect(result).toEqual({ ok: false, reason: 'self_transfer' });
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.listBalanceEvents('ada')).toHaveLength(events);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a non-positive or non-finite amount', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      const at = h.clock.now();
      const senderEvents = h.ledger.listBalanceEvents('ada').length;
      const recipientEvents = h.ledger.listBalanceEvents('bob').length;
      for (const amount of [0, -1, 0.0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(h.ledger.transferBalance('ada', 'bob', amount, at)).toEqual({
          ok: false,
          reason: 'invalid_amount',
        });
      }
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.getBalance('bob')).toBe(100);
      expect(h.ledger.listBalanceEvents('ada')).toHaveLength(senderEvents);
      expect(h.ledger.listBalanceEvents('bob')).toHaveLength(recipientEvents);
      expect(h.ledger.listMessagesForAgent('bob')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a sender or recipient that is not in the ledger', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      const at = h.clock.now();
      expect(h.ledger.transferBalance('nobody', 'ada', 1, at)).toEqual({
        ok: false,
        reason: 'sender_not_found',
      });
      expect(h.ledger.transferBalance('ada', 'nobody', 1, at)).toEqual({
        ok: false,
        reason: 'recipient_not_found',
      });
      expect(h.ledger.getBalance('ada')).toBe(100);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a dead sender and a dead recipient', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      birthAgent(h, 'cleo');
      const at = h.clock.now();
      expect(h.ledger.markAgentDead('bob')).toBe(true);
      expect(h.ledger.markAgentDead('cleo')).toBe(true);
      expect(h.ledger.transferBalance('bob', 'ada', 1, at)).toEqual({
        ok: false,
        reason: 'sender_not_alive',
      });
      expect(h.ledger.transferBalance('ada', 'cleo', 1, at)).toEqual({
        ok: false,
        reason: 'recipient_not_alive',
      });
      // A transfer between two dead agents still names the sender first.
      expect(h.ledger.transferBalance('bob', 'cleo', 1, at)).toEqual({
        ok: false,
        reason: 'sender_not_alive',
      });
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.listBalanceEvents('ada')).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('checks the amount and the sender before the recipient', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      birthAgent(h, 'ada');
      const at = h.clock.now();
      // Every precondition is broken at once; the first one decides.
      expect(h.ledger.transferBalance('ada', 'ada', -1, at)).toEqual({
        ok: false,
        reason: 'self_transfer',
      });
      expect(h.ledger.transferBalance('nobody', 'ghost', -1, at)).toEqual({
        ok: false,
        reason: 'invalid_amount',
      });
      expect(h.ledger.transferBalance('nobody', 'ghost', 1, at)).toEqual({
        ok: false,
        reason: 'sender_not_found',
      });
    } finally {
      h.cleanup();
    }
  });
});

describe('a transfer survives being read back', () => {
  it('keeps both sides reachable through the agent message view', () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const ada: AgentRecord = birthAgent(h, 'ada');
      const bob = birthAgent(h, 'bob');
      const at = h.clock.now() + 5000;
      const result = h.ledger.transferBalance(ada.name, bob.name, 7.25, at);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.senderBalance).toBe(92.75);
      expect(result.recipientBalance).toBe(107.25);

      const seenByBob = h.ledger.listMessagesForAgent('bob');
      expect(seenByBob.map((message) => message.body)).toEqual(['Received 7.25 balance from ada.']);
      expect(seenByBob[0]?.sender).toBe('system');
      expect(seenByBob[0]?.recipient).toBe('bob');
      expect(seenByBob[0]?.readAt).toBeNull();

      h.ledger.markMessagesRead(
        seenByBob.map((message) => message.id),
        at + 1,
      );
      expect(h.ledger.listUnreadMessages('bob')).toEqual([]);
      expect(h.ledger.listMessagesForAgent('bob')[0]?.readAt).toBe(at + 1);
    } finally {
      h.cleanup();
    }
  });
});
