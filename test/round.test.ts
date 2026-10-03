import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentHomeDir, agentMemoryPath } from '../src/config';
import type { AgentRecord } from '../src/organs/ledger';
import { readBodyStatus } from '../src/organs/metabolism';
import type { ChatResponse } from '../src/model/client';
import { createTask } from '../src/organs/taskboard';
import { RoundCoordinator, type WorkerTransport } from '../src/supervisor/round';
import {
  birthAgent,
  createHarness,
  initWorker,
  InProcessWorker,
  memoryResponse,
  ScriptedModelClient,
  testPrompts,
  textResponse,
  toolCallResponse,
  type Harness,
} from './helpers';

function makeCoordinator(
  h: Harness,
  memoryResponses: ReturnType<typeof memoryResponse>[],
  errors: string[],
  onPromptWarnings?: (warnings: string[]) => void,
): RoundCoordinator {
  return new RoundCoordinator({
    ledger: h.ledger,
    values: h.values,
    paths: h.paths,
    blackbox: h.blackbox,
    now: h.clock.now,
    memory: new ScriptedModelClient(memoryResponses),
    prompts: testPrompts(h),
    onPromptWarnings,
    onMemoryError: (agent, message) => {
      errors.push(`${agent}: ${message}`);
    },
  });
}

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

function wakeOf(worker: WorkerTransport): Extract<Parameters<WorkerTransport['send']>[0], { type: 'wake' }> {
  const sent = (worker as InProcessWorker).sent;
  const wake = sent.find((message) => message.type === 'wake');
  if (wake === undefined || wake.type !== 'wake') {
    throw new Error('the round never sent a wake message');
  }
  return wake;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('a round', () => {
  it('ends as soon as the model answers without tool calls', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { outcome } = await runRound(h, agent, [textResponse('I am fine.')]);
      expect(outcome.endReason).toBe('final');
      expect(outcome.finalReply).toBe('I am fine.');
      expect(outcome.error).toBeNull();

      const rounds = h.ledger.listRounds('ada', 5);
      expect(rounds.length).toBe(1);
      expect(rounds[0].endReason).toBe('final');
      expect(rounds[0].endedAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('executes tool calls in the supervisor and answers the worker', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const agentModel = new ScriptedModelClient([
        toolCallResponse([{ id: 'c1', name: 'get_status', args: {} }]),
        textResponse('I read my body.'),
      ]);
      const worker = initWorker(h, agentModel);
      const outcome = await makeCoordinator(h, [memoryResponse('ada', agent.bornAt, 'I checked.')], []).run(
        agent,
        worker,
      );
      expect(outcome.endReason).toBe('final');

      const results = worker.sent.filter((message) => message.type === 'tool_result');
      expect(results.length).toBe(1);
      const first = results[0];
      if (first === undefined || first.type !== 'tool_result') {
        throw new Error('expected one tool result');
      }
      expect(first.isError).toBe(false);
      expect(first.content).toContain('"ok":true');
      expect(first.content).toContain('"balance":100');

      const secondRequest = agentModel.requests[1];
      expect(secondRequest).toBeDefined();
      const toolMessage = secondRequest.messages.find((message) => message.role === 'tool');
      expect(toolMessage?.toolCallId).toBe('c1');

      const kinds = h.blackbox.readRecentRounds('ada', 3).flatMap((round) => round.entries.map((e) => e.kind));
      expect(kinds).toContain('tool_call');
      expect(kinds).toContain('tool_result');
      expect(kinds).toContain('assistant_message');
      expect(kinds).toContain('round_end');
    } finally {
      h.cleanup();
    }
  });

  it('lets a tool actually change the ledger, and only through the tool', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      h.clock.advanceSeconds(600);
      const before = readBodyStatus(h.ledger, h.values, 'ada', h.clock.now());
      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'eat', args: {} }]),
        textResponse('I ate.'),
      ]);
      const after = readBodyStatus(h.ledger, h.values, 'ada', h.clock.now());
      expect(after.balance).toBe(before.balance - h.values.mealPrice);
      expect(after.satiety).toBeGreaterThan(before.satiety);

      const results = worker.sent.filter((message) => message.type === 'tool_result');
      expect(results.length).toBe(1);
      expect(h.blackbox.readRecentRounds('ada', 3).flatMap((r) => r.entries.map((e) => e.kind))).toContain('meal');
    } finally {
      h.cleanup();
    }
  });

  it('refuses an unknown tool without touching anything', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'run_shell', args: { command: 'dir' } }]),
        textResponse('That tool does not exist.'),
      ]);
      const results = worker.sent.filter((message) => message.type === 'tool_result');
      const first = results[0];
      if (first === undefined || first.type !== 'tool_result') {
        throw new Error('expected one tool result');
      }
      expect(first.isError).toBe(true);
      expect(first.content).toContain('unknown tool');
      expect(h.ledger.getBalance('ada')).toBe(100);
    } finally {
      h.cleanup();
    }
  });

  it('forces an end when the prompt exceeds the context cap, without running tools', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { outcome, worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'eat', args: {} }], {
          promptTokens: h.values.roundContextCapTokens + 1,
          completionTokens: 10,
        }),
      ]);
      expect(outcome.endReason).toBe('context_cap');
      expect(worker.sent.some((message) => message.type === 'tool_result')).toBe(false);
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.listRounds('ada', 1)[0].endReason).toBe('context_cap');
    } finally {
      h.cleanup();
    }
  });

  it('forces an end once the model has asked for more tool calls than the config allows', async () => {
    const h = createHarness({ values: { maxToolCallsPerRound: 3 } });
    try {
      const agent = birthAgent(h, 'ada');
      // Two calls per answer: the first answer fits under the limit, the second
      // would pass it and is refused whole, so no call is left unanswered.
      const answer = (suffix: string) =>
        toolCallResponse([
          { id: `c_${suffix}_1`, name: 'get_status', args: {} },
          { id: `c_${suffix}_2`, name: 'get_status', args: {} },
        ]);
      const { outcome, worker } = await runRound(h, agent, [answer('a'), answer('b')]);
      expect(outcome.endReason).toBe('iteration_cap');
      expect(outcome.error).toContain(`over the round limit of ${h.values.maxToolCallsPerRound}`);

      // Exactly the allowed batches were run, and the round really did stop.
      const results = worker.sent.filter((message) => message.type === 'tool_result');
      expect(results.length).toBe(2);
      const executed = results.filter((message) => message.type === 'tool_result');
      expect(executed.map((message) => (message.type === 'tool_result' ? message.callId : ''))).toEqual([
        'c_a_1',
        'c_a_2',
      ]);
      expect(h.ledger.listRounds('ada', 1)[0].endReason).toBe('iteration_cap');
    } finally {
      h.cleanup();
    }
  });

  it('takes the tool-call limit from the config, not from a constant', async () => {
    const h = createHarness({ values: { maxToolCallsPerRound: 1 } });
    try {
      const agent = birthAgent(h, 'ada');
      const { outcome, worker } = await runRound(h, agent, [
        toolCallResponse([
          { id: 'c1', name: 'get_status', args: {} },
          { id: 'c2', name: 'get_status', args: {} },
        ]),
      ]);
      expect(outcome.endReason).toBe('iteration_cap');
      expect(worker.sent.some((message) => message.type === 'tool_result')).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('forces an end when the provider reports no usage, and logs it', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { outcome } = await runRound(h, agent, [
        { message: { role: 'assistant', content: 'thinking' }, usage: null },
      ]);
      expect(outcome.endReason).toBe('usage_missing');
      expect(outcome.error).not.toBeNull();
      const kinds = h.blackbox.readRecentRounds('ada', 3).flatMap((r) => r.entries.map((e) => e.kind));
      expect(kinds).toContain('usage_missing');
      expect(h.ledger.sumUsage('ada', 'agent').records).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('records token usage without charging satiety or balance', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const balanceBefore = h.ledger.getBalance('ada');
      const satietyBefore = readBodyStatus(h.ledger, h.values, 'ada', h.clock.now()).satiety;
      h.clock.advanceSeconds(60);

      await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'get_status', args: {} }]),
        textResponse('nothing to do', { promptTokens: 5000, completionTokens: 12 }),
      ]);

      const totals = h.ledger.sumUsage('ada', 'agent');
      expect(totals.records).toBe(2);
      expect(totals.promptTokens).toBe(5100);
      expect(totals.completionTokens).toBe(32);
      expect(h.ledger.getBalance('ada')).toBe(balanceBefore);
      // Satiety still fell at exactly the wall-clock rate, no faster.
      const satietyAfter = readBodyStatus(h.ledger, h.values, 'ada', h.clock.now()).satiety;
      expect(satietyAfter).toBeCloseTo(satietyBefore - 3, 6);
    } finally {
      h.cleanup();
    }
  });

  it('leaves nothing in the agent home but MEMORY and the notebook, and no number on disk', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'notebook_write', args: { path: 'notes.txt', content: 'no numbers here' } }]),
        textResponse('written'),
      ]);
      const home = agentHomeDir(h.paths, 'ada');
      expect(readdirSync(home).sort()).toEqual(['MEMORY', 'notebook']);

      const files = walk(home);
      for (const file of files) {
        const name = path.basename(file).toLowerCase();
        expect(name).not.toMatch(/satiety|balance|money|hunger|wallet|status/);
        const text = readFileSync(file, 'utf8');
        expect(text).not.toMatch(/satiety\s*[:=]\s*\d/i);
        expect(text).not.toMatch(/balance\s*[:=]\s*\d/i);
      }
      expect(readFileSync(agentMemoryPath(h.paths, 'ada'), 'utf8')).toContain('I woke and checked my body.');
    } finally {
      h.cleanup();
    }
  });

  it('injects MEMORY, body state, the board and unread messages, then marks them read', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const written = 'I remember: the operator asked me to eat.';
      createTask(h.ledger, {
        id: 'task_0001',
        title: 'Count the clouds',
        description: 'Write down how many you saw.',
        price: 12,
        at: h.clock.now(),
      });
      h.ledger.appendMessage('operator', 'ada', 'Please eat something soon.', h.clock.now());

      // First round writes MEMORY.
      const first = await runRound(h, agent, [textResponse('first reply text')], [
        memoryResponse('ada', agent.bornAt, written),
      ]);
      expect(first.outcome.memory?.status).toBe('updated');

      // Second round must start from that MEMORY and nothing else from round one.
      h.clock.advanceSeconds(h.values.heartbeatSeconds);
      const second = await runRound(h, agent, [textResponse('second reply text')], [
        memoryResponse('ada', agent.bornAt, written),
      ]);
      const wake = wakeOf(second.worker);
      expect(wake.user).toContain(written);
      expect(wake.user).not.toContain('first reply text');
      expect(wake.user).toContain('# BODY STATE');
      expect(wake.user).toMatch(/satiety: \d/);
      expect(wake.user).toMatch(/balance: \d/);
      expect(wake.user).toContain('Count the clouds');
      expect(wake.user).not.toContain('Please eat something soon.');
      expect(wake.system).toContain('You are an agent in the Conservatory');

      // The first round's unread message was injected there and is now read.
      expect(h.ledger.listUnreadMessages('ada')).toEqual([]);
      expect(h.ledger.listMessagesForOperator().length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('delivers the operator message in the round it arrives for', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      h.ledger.appendMessage('operator', 'ada', 'Are you hungry?', h.clock.now());
      const { worker } = await runRound(h, agent, [textResponse('checking')]);
      const wake = wakeOf(worker);
      expect(wake.user).toContain('Are you hungry?');
      expect(wake.user).toContain('# MESSAGES FROM THE OPERATOR');
    } finally {
      h.cleanup();
    }
  });

  it('runs memory consolidation and records memory usage separately', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { outcome } = await runRound(h, agent, [textResponse('hello')]);
      expect(outcome.memory?.status).toBe('updated');
      expect(h.ledger.sumUsage('ada', 'memory').records).toBe(1);
      expect(h.ledger.sumUsage('ada', 'memory').promptTokens).toBe(200);
      expect(h.ledger.sumUsage('ada', 'agent').records).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('survives a worker that dies mid-round', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const worker: WorkerTransport = {
        send: () => {
          throw new Error('the child is gone');
        },
        onMessage: () => undefined,
      };
      const coordinator = makeCoordinator(h, [], []);
      const outcome = await coordinator.run(agent, worker);
      expect(outcome.endReason).toBe('model_error');
      expect(outcome.error).toContain('the child is gone');
    } finally {
      h.cleanup();
    }
  });
});
