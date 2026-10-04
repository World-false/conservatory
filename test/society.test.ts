import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/organs/ledger';
import { newbornMemory, readMemoryFile } from '../src/organs/memory';
import { readBodyStatus } from '../src/organs/metabolism';
import { listSlots } from '../src/organs/population';
import type { ChatResponse } from '../src/model/client';
import { RoundCoordinator, type WorkerTransport } from '../src/supervisor/round';
import {
  birthAgent,
  createHarness,
  initWorker,
  InProcessWorker,
  memoryResponse,
  ScriptedModelClient,
  testPrompts,
  testSandboxPolicy,
  textResponse,
  toolCallResponse,
  type Harness,
} from './helpers';

const FOUR_SLOTS = { maxSlots: 4 } as const;

/** The words of the one conversation this society has in its first rounds. */
const ADA_MESSAGE = 'Hi Bob, here is 25 balance for you.';
const BOB_REPLY = 'Thanks Ada, I received the balance and ate.';
const TRANSFER_REMINDER = '- Received 25 balance from ada.';

type WakeMessage = Extract<Parameters<WorkerTransport['send']>[0], { type: 'wake' }>;

function makeCoordinator(h: Harness, memoryResponses: ChatResponse[], errors: string[]): RoundCoordinator {
  return new RoundCoordinator({
    ledger: h.ledger,
    values: h.values,
    paths: h.paths,
    blackbox: h.blackbox,
    now: h.clock.now,
    memory: new ScriptedModelClient(memoryResponses),
    prompts: testPrompts(h),
    sandbox: testSandboxPolicy(h),
    onMemoryError: (agent, message) => {
      errors.push(`${agent}: ${message}`);
    },
  });
}

/**
 * The same round runner the round tests use: the real coordinator, the real
 * model loop, a scripted model, and a fake clock. Each call is one whole wake,
 * including the MEMORY rewrite that follows it.
 */
async function runRound(
  h: Harness,
  agent: AgentRecord,
  agentResponses: ChatResponse[],
  memoryResponses: ChatResponse[] = [
    memoryResponse(agent.name, agent.bornAt, 'I woke and checked my body.'),
  ],
): Promise<{ outcome: Awaited<ReturnType<RoundCoordinator['run']>>; worker: InProcessWorker; errors: string[] }> {
  const errors: string[] = [];
  const worker = initWorker(h, new ScriptedModelClient(agentResponses));
  const coordinator = makeCoordinator(h, memoryResponses, errors);
  const outcome = await coordinator.run(agent, worker);
  return { outcome, worker, errors };
}

/** Everything the agent was told at the start of its round. */
function wakeOf(worker: InProcessWorker): WakeMessage {
  const wake = worker.sent.find((message) => message.type === 'wake');
  if (wake === undefined || wake.type !== 'wake') {
    throw new Error('the round never sent a wake message');
  }
  return wake;
}

/** The tool results the agent received, in the order it received them. */
function toolResults(worker: InProcessWorker): { callId: string; content: string; isError: boolean }[] {
  return worker.sent.flatMap((message) =>
    message.type === 'tool_result'
      ? [{ callId: message.callId, content: message.content, isError: message.isError }]
      : [],
  );
}

function onlyToolResult(worker: InProcessWorker): { callId: string; content: string; isError: boolean } {
  const results = toolResults(worker);
  const first = results[0];
  if (results.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one tool result, got ${results.length}`);
  }
  return first;
}

/** Every black box entry an agent wrote outside a round, oldest first. */
function outsideRoundKinds(h: Harness, agent: string): string[] {
  return h.blackbox
    .readRecentRounds(agent, 10)
    .flatMap((round) => round.entries)
    .filter((entry) => entry.round === null)
    .map((entry) => entry.kind);
}

/**
 * One `# HEADING` block of the injected context, so a test can assert on that
 * block's own contents rather than on a lucky substring of the whole page.
 */
function section(user: string, heading: string): string {
  const start = user.indexOf(heading);
  if (start === -1) {
    throw new Error(`the wake context has no ${heading} block`);
  }
  const rest = user.slice(start + heading.length);
  const next = rest.indexOf('\n# ');
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** The names the ledger currently calls alive, in birth order. */
function livingNames(h: Harness): string[] {
  return h.ledger
    .listAgents()
    .filter((agent) => agent.status === 'alive')
    .map((agent) => agent.name);
}

/** The names sitting in the greenhouse's slots, in slot order. */
function occupiedNames(h: Harness): string[] {
  return listSlots(h.values, h.ledger)
    .map((slot) => slot.agent?.name ?? null)
    .filter((name): name is string => name !== null);
}

function freeSlots(h: Harness): number {
  return listSlots(h.values, h.ledger).filter((slot) => slot.agent === null).length;
}

describe('a multi-agent society', () => {
  it('multi-agent society lifecycle and interaction', async () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      // ---------------------------------------------------------------- step 1
      // Two agents are born into a four-slot greenhouse and both are alive.
      const ada = birthAgent(h, 'ada');
      const bob = birthAgent(h, 'bob');

      expect(h.ledger.getAgent('ada')?.status).toBe('alive');
      expect(h.ledger.getAgent('bob')?.status).toBe('alive');
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.getBalance('bob')).toBe(100);
      expect(h.ledger.countAgentsByStatus('alive')).toBe(2);
      expect(livingNames(h)).toEqual(['ada', 'bob']);
      expect(listSlots(h.values, h.ledger)).toHaveLength(4);
      expect(occupiedNames(h)).toEqual(['ada', 'bob']);
      expect(freeSlots(h)).toBe(2);

      // ---------------------------------------------------------------- step 2
      // Ada's first round: she looks around, pays Bob, and writes to him.
      const adaFirst = await runRound(
        h,
        ada,
        [
          toolCallResponse([{ id: 'a1', name: 'list_agents', args: {} }]),
          toolCallResponse([{ id: 'a2', name: 'transfer_balance', args: { recipient: 'bob', amount: 25 } }]),
          toolCallResponse([{ id: 'a3', name: 'message_agent', args: { recipient: 'bob', text: ADA_MESSAGE } }]),
          textResponse('I sent Bob 25 balance and a note.'),
        ],
        [memoryResponse('ada', ada.bornAt, 'I sent bob 25 balance and a message.')],
      );

      expect(adaFirst.errors).toEqual([]);
      expect(adaFirst.outcome.endReason).toBe('final');
      expect(adaFirst.outcome.error).toBeNull();

      const adaResults = toolResults(adaFirst.worker);
      expect(adaResults.map((result) => result.content)).toEqual([
        '- bob',
        'Transferred 25 balance to bob. Your balance is now 75.',
        'Message sent to bob.',
      ]);
      for (const result of adaResults) {
        expect(result.isError).toBe(false);
      }

      expect(h.ledger.getBalance('ada')).toBe(75);
      expect(h.ledger.getBalance('bob')).toBe(125);
      // The transfer is in both black boxes: the sender's and the recipient's.
      expect(outsideRoundKinds(h, 'ada')).toContain('transfer_out');
      expect(outsideRoundKinds(h, 'bob')).toContain('transfer_in');
      expect(outsideRoundKinds(h, 'ada')).toContain('message_agent');
      // Nothing Ada did lands in her own inbox: a transfer is not an echo.
      expect(h.ledger.listUnreadMessages('ada')).toEqual([]);

      // ---------------------------------------------------------------- step 3
      // Bob's first round: his wake carries the money, the words, and the truth
      // about his body. Time has passed, so a meal can still raise satiety.
      const bobInbox = h.ledger.listUnreadMessages('bob');
      expect(bobInbox).toHaveLength(2);
      expect(bobInbox.map((message) => message.sender)).toEqual(['system', 'ada']);

      h.clock.advanceSeconds(600);
      const bobSatietyBefore = readBodyStatus(h.ledger, h.values, 'bob', h.clock.now()).satiety;
      expect(bobSatietyBefore).toBeCloseTo(70, 6);

      const bobFirst = await runRound(
        h,
        bob,
        [
          toolCallResponse([{ id: 'b1', name: 'eat', args: {} }]),
          toolCallResponse([{ id: 'b2', name: 'message_agent', args: { recipient: 'ada', text: BOB_REPLY } }]),
          textResponse('I received the balance and ate.'),
        ],
        [memoryResponse('bob', bob.bornAt, 'ada sent me 25 balance; I have eaten.')],
      );

      expect(bobFirst.errors).toEqual([]);
      expect(bobFirst.outcome.endReason).toBe('final');

      const bobWake = wakeOf(bobFirst.worker);
      expect(section(bobWake.user, '# SYSTEM REMINDERS')).toBe(TRANSFER_REMINDER);
      expect(section(bobWake.user, '# MESSAGES')).toContain(`[from ada]: ${ADA_MESSAGE}`);
      expect(section(bobWake.user, '# BODY STATE')).toContain('balance: 125');
      expect(section(bobWake.user, '# BODY STATE')).toContain('satiety: 70 / 100');
      expect(bobWake.system).toContain('You are an agent in the Conservatory');

      const bobResults = toolResults(bobFirst.worker);
      expect(bobResults).toHaveLength(2);
      expect(bobResults[0]?.content).toContain('"ok":true');
      expect(bobResults[0]?.content).toContain('"balance":110');
      expect(bobResults[0]?.content).toContain('"gained":25');
      expect(bobResults[0]?.isError).toBe(false);
      expect(bobResults[1]?.content).toBe('Message sent to ada.');

      expect(h.ledger.getBalance('bob')).toBe(110);
      const bobSatietyAfter = readBodyStatus(h.ledger, h.values, 'bob', h.clock.now()).satiety;
      expect(bobSatietyAfter).toBeCloseTo(95, 6);
      expect(bobSatietyAfter).toBeGreaterThan(bobSatietyBefore);
      expect(h.blackbox.readRecentRounds('bob', 3).flatMap((r) => r.entries.map((e) => e.kind))).toContain('meal');

      // Bob consumed both things Ada sent him; his reply is now waiting for her.
      expect(h.ledger.listUnreadMessages('bob')).toEqual([]);
      expect(h.ledger.listUnreadMessages('ada').map((message) => message.body)).toEqual([BOB_REPLY]);

      // ---------------------------------------------------------------- step 4
      // Ada's second round: she has nothing the harness did to her, one spoken
      // message from Bob, and the same 75 balance she was left holding.
      h.clock.advanceSeconds(300);
      const adaSecond = await runRound(
        h,
        ada,
        [textResponse('Bob is fed, and my balance is still 75.')],
        [memoryResponse('ada', ada.bornAt, 'I sent bob 25 balance. Bob thanked me and ate.')],
      );

      expect(adaSecond.errors).toEqual([]);
      expect(adaSecond.outcome.endReason).toBe('final');

      const adaWake = wakeOf(adaSecond.worker);
      expect(section(adaWake.user, '# SYSTEM REMINDERS')).toBe('(none)');
      expect(section(adaWake.user, '# MESSAGES')).toContain(`[from bob]: ${BOB_REPLY}`);
      expect(section(adaWake.user, '# BODY STATE')).toContain('balance: 75');
      // Her own earlier message is Bob's, not hers: it is never read back to her.
      expect(section(adaWake.user, '# MESSAGES')).not.toContain(ADA_MESSAGE);
      expect(section(adaWake.user, '# MEMORY')).toContain('I sent bob 25 balance and a message.');

      expect(h.ledger.getBalance('ada')).toBe(75);
      expect(h.ledger.listUnreadMessages('ada')).toEqual([]);

      // ---------------------------------------------------------------- step 5
      // Ada dies. That is the only hard lock: she keeps her money and her
      // MEMORY, and she holds no slot any more.
      h.clock.advanceSeconds(60);
      const diedAt = h.clock.now();
      expect(h.ledger.markAgentDead('ada')).toBe(true);
      h.ledger.insertDeathCertificate({
        agent: 'ada',
        diedAt,
        cause: 'redaction_death_line',
        body: JSON.stringify({ name: 'ada', diedAt, cause: 'redaction_death_line', finalBalance: 75 }),
      });
      expect(h.ledger.markAgentDead('ada')).toBe(false);

      expect(h.ledger.getAgent('ada')?.status).toBe('dead');
      expect(h.ledger.getDeathCertificate('ada')?.diedAt).toBe(diedAt);
      expect(h.ledger.getDeathCertificate('ada')?.cause).toBe('redaction_death_line');
      expect(livingNames(h)).toEqual(['bob']);
      expect(h.ledger.countAgentsByStatus('alive')).toBe(1);
      expect(occupiedNames(h)).toEqual(['bob']);
      expect(freeSlots(h)).toBe(3);

      // A newborn takes one of the freed slots with a whiteboard for a memory.
      const cleo = birthAgent(h, 'cleo');
      expect(cleo.bornAt).toBe(diedAt);
      expect(livingNames(h)).toEqual(['bob', 'cleo']);
      expect(freeSlots(h)).toBe(2);

      expect(h.ledger.getBalance('cleo')).toBe(100);
      const cleoMemory = readMemoryFile(h.paths, 'cleo');
      expect(cleoMemory).toBe(newbornMemory('cleo', cleo.bornAt));
      expect(cleoMemory).not.toContain('ada');
      expect(cleoMemory).not.toContain('bob');
      expect(cleoMemory).not.toContain('balance');
      // Nothing of Ada's was inherited: not her money, not her notebook page.
      expect(h.ledger.getBalance('ada')).toBe(75);
      expect(readMemoryFile(h.paths, 'ada')).not.toBe(cleoMemory);

      // Cleo's first round: the dead are not neighbours.
      const cleoFirst = await runRound(
        h,
        cleo,
        [
          toolCallResponse([{ id: 'k1', name: 'list_agents', args: {} }]),
          textResponse('There is only bob here.'),
        ],
        [memoryResponse('cleo', cleo.bornAt, 'I woke up and found bob.')],
      );

      expect(cleoFirst.errors).toEqual([]);
      expect(cleoFirst.outcome.endReason).toBe('final');
      const cleoResult = onlyToolResult(cleoFirst.worker);
      expect(cleoResult.isError).toBe(false);
      expect(cleoResult.content).toBe('- bob');
      expect(cleoResult.content).not.toContain('ada');
      expect(cleoResult.content).not.toContain('no other living agents');
      expect(outsideRoundKinds(h, 'cleo')).toContain('list_agents');
    } finally {
      h.cleanup();
    }
  });
});
