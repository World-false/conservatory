import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentHomeDir, agentMemoryPath, agentNotebookDir } from '../src/config';
import type { AgentRecord } from '../src/organs/ledger';
import { readMemoryFile, writeMemoryAtomic } from '../src/organs/memory';
import { readBodyStatus } from '../src/organs/metabolism';
import { renderSentence } from '../src/organs/redaction';
import type { ChatResponse } from '../src/model/client';
import { createTask } from '../src/organs/taskboard';
import { RoundCoordinator, type WorkerTransport } from '../src/supervisor/round';
import {
  birthAgent,
  createHarness,
  initWorker,
  insertAgentRow,
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

/** The one tool result of a round, or a thrown error naming what went wrong. */
function onlyResult(worker: InProcessWorker): { content: string; isError: boolean } {
  const results = worker.sent.filter((message) => message.type === 'tool_result');
  const first = results[0];
  if (results.length !== 1 || first === undefined || first.type !== 'tool_result') {
    throw new Error(`expected exactly one tool result, got ${results.length}`);
  }
  return { content: first.content, isError: first.isError };
}

/** Every black box entry an agent wrote outside a round, oldest first. */
function outsideRoundKinds(h: Harness, agent: string): string[] {
  return h.blackbox
    .readRecentRounds(agent, 10)
    .flatMap((round) => round.entries)
    .filter((entry) => entry.round === null)
    .map((entry) => entry.kind);
}

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
    sandbox: testSandboxPolicy(h),
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

  it.skipIf(process.platform !== 'win32')(
    'runs execute_command inside the agent own notebook and records it in the black box',
    async () => {
      const h = createHarness();
      try {
        const agent = birthAgent(h, 'ada');
        const agentModel = new ScriptedModelClient([
          toolCallResponse([
            { id: 'c1', name: 'execute_command', args: { command: 'echo from-agent > fromagent.txt', shell: 'cmd' } },
          ]),
          textResponse('I ran it.'),
        ]);
        const worker = initWorker(h, agentModel);
        const outcome = await makeCoordinator(h, [memoryResponse('ada', agent.bornAt, 'I ran a command.')], []).run(
          agent,
          worker,
        );
        expect(outcome.endReason).toBe('final');

        const first = worker.sent.filter((message) => message.type === 'tool_result')[0];
        if (first === undefined || first.type !== 'tool_result') {
          throw new Error('expected one tool result');
        }
        expect(first.isError).toBe(false);
        expect(first.content).toContain('"exitCode":0');
        expect(first.content).toContain('"timedOut":false');

        const notebook = agentNotebookDir(h.paths, 'ada');
        expect(readFileSync(path.join(notebook, 'fromagent.txt'), 'utf8')).toContain('from-agent');

        const kinds = h.blackbox.readRecentRounds('ada', 3).flatMap((round) => round.entries.map((e) => e.kind));
        expect(kinds).toContain('command_executed');
      } finally {
        h.cleanup();
      }
    },
    60_000,
  );

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
      expect(wake.user).toContain('[from operator]');
      expect(wake.user).toContain('# MESSAGES');
      expect(wake.user).toContain('# SYSTEM REMINDERS');
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

  it('wakes the model with the wounds, the death line, and both treatment prices in the body state', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { worker } = await runRound(h, agent, [textResponse('checking')]);
      const wake = wakeOf(worker);
      expect(wake.user).toContain('untreated redacted characters: 0 / death line 2000');
      expect(wake.user).toContain('wounds not fully healed: 0');
      expect(wake.user).toContain('treatment prices: ordinary 25, complete 80');
      expect(wake.system).toContain('WOUNDS');
      expect(wake.system).toContain('TREATMENT');
      expect(wake.system).toContain('DEATH');
    } finally {
      h.cleanup();
    }
  });

  it('lets the agent list its wounds without ever leaking the original text', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const original = 'The vault code is 4471 and it matters.';
      const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now());
      h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 18,
        length: 4,
        originalText: '4471',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      const visible = renderSentence(original, h.ledger.listWounds('ada'));
      writeMemoryAtomic(h.paths, 'ada', `${'Name: ada'}\nBorn: ${new Date(agent.bornAt).toISOString()}\n${visible}`);

      const { outcome, worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'list_wounds', args: {} }]),
        textResponse('I saw my wounds.'),
      ]);
      expect(outcome.endReason).toBe('final');
      const results = worker.sent.filter((message) => message.type === 'tool_result');
      const first = results[0];
      if (first === undefined || first.type !== 'tool_result') {
        throw new Error('expected one tool result');
      }
      expect(first.content).toContain('"ok":true');
      expect(first.content).toContain('"status":"untreated"');
      expect(first.content).toContain('"length":4');
      expect(first.content).toContain(visible);
      expect(first.content).not.toContain('4471');
      expect(first.content).not.toContain('original_text');

      // The same denial applies to the black box the agent cannot read anyway.
      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      const toolResult = entries.find((entry) => entry.kind === 'tool_result');
      expect(toolResult?.['content']).not.toContain('4471');
    } finally {
      h.cleanup();
    }
  });

  it('lets the agent treat its own wound through the treat tool', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const original = 'The vault code is 4471 and it matters.';
      const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now());
      const woundId = h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 18,
        length: 4,
        originalText: '4471',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      const visible = renderSentence(original, h.ledger.listWounds('ada'));
      writeMemoryAtomic(h.paths, 'ada', `${'Name: ada'}\nBorn: ${new Date(agent.bornAt).toISOString()}\n${visible}`);

      const { worker } = await runRound(
        h,
        agent,
        [
          toolCallResponse([{ id: 'c1', name: 'treat', args: { wound_id: woundId, tier: 'complete' } }]),
          textResponse('I treated it.'),
        ],
        [memoryResponse('ada', agent.bornAt, `I treated my wound. ${original}`)],
      );
      const first = worker.sent.filter((message) => message.type === 'tool_result')[0];
      if (first === undefined || first.type !== 'tool_result') {
        throw new Error('expected one tool result');
      }
      expect(first.content).toContain('"ok":true');
      expect(first.content).toContain('"status":"healed"');
      expect(h.ledger.getWound(woundId)?.status).toBe('healed');
      expect(h.ledger.getBalance('ada')).toBe(100 - h.values.completeTreatmentPrice);
      // The healed sentence is released, so the memory system may keep it as it
      // is; the treatment already put the original characters back.
      expect(h.ledger.listActiveFrozenSentences('ada')).toEqual([]);
      expect(readMemoryFile(h.paths, 'ada')).toContain(original);
      expect(h.ledger.listTreatments('ada').length).toBe(1);
      expect(h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries.map((e) => e.kind))).toContain(
        'treatment',
      );
    } finally {
      h.cleanup();
    }
  });

  it('refuses a treat the agent cannot afford, and changes nothing', async () => {
    const h = createHarness({ values: { initialBalance: 3 } });
    try {
      const agent = birthAgent(h, 'ada');
      const original = 'The vault code is 4471 and it matters.';
      const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now());
      const woundId = h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 18,
        length: 4,
        originalText: '4471',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      const visible = renderSentence(original, h.ledger.listWounds('ada'));
      writeMemoryAtomic(h.paths, 'ada', `${'Name: ada'}\nBorn: ${new Date(agent.bornAt).toISOString()}\n${visible}`);

      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'treat', args: { wound_id: woundId, tier: 'ordinary' } }]),
        textResponse('I could not afford it.'),
      ]);
      const first = worker.sent.filter((message) => message.type === 'tool_result')[0];
      if (first === undefined || first.type !== 'tool_result') {
        throw new Error('expected one tool result');
      }
      expect(first.content).toContain('"error":"insufficient_balance"');
      expect(h.ledger.getBalance('ada')).toBe(3);
      expect(h.ledger.getWound(woundId)?.status).toBe('untreated');
      expect(readMemoryFile(h.paths, 'ada')).toContain(visible);
      expect(h.blackbox.readRecentRounds('ada', 5).flatMap((r) => r.entries.map((e) => e.kind))).toContain(
        'treatment_refused',
      );
    } finally {
      h.cleanup();
    }
  });

  it('rejects a treat call with a bad tier or a non-integer id', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { worker } = await runRound(h, agent, [
        toolCallResponse([
          { id: 'c1', name: 'treat', args: { wound_id: 1, tier: 'cheap' } },
          { id: 'c2', name: 'treat', args: { wound_id: 'one', tier: 'ordinary' } },
        ]),
        textResponse('Those were wrong.'),
      ]);
      const results = worker.sent.filter((message) => message.type === 'tool_result');
      expect(results.length).toBe(2);
      for (const result of results) {
        if (result.type !== 'tool_result') {
          continue;
        }
        expect(result.isError).toBe(true);
      }
      expect(h.ledger.getBalance('ada')).toBe(100);
    } finally {
      h.cleanup();
    }
  });

  it('reports the new numbers through get_status', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'get_status', args: {} }]),
        textResponse('read'),
      ]);
      const first = worker.sent.filter((message) => message.type === 'tool_result')[0];
      if (first === undefined || first.type !== 'tool_result') {
        throw new Error('expected one tool result');
      }
      expect(first.content).toContain('"untreatedRedactedChars":0');
      expect(first.content).toContain('"deathLineChars":2000');
      expect(first.content).toContain('"ordinaryTreatmentPrice":25');
      expect(first.content).toContain('"completeTreatmentPrice":80');
    } finally {
      h.cleanup();
    }
  });

  it('survives a worker that dies mid-round', async () => {    const h = createHarness();
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

describe('the social tools', () => {
  it('lists the other living agents, and never the agent itself', async () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const agent = birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      const carol = insertAgentRow(h, 'carol');
      h.ledger.markAgentDead(carol.name);

      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'list_agents', args: {} }]),
        textResponse('I see bob.'),
      ]);
      const result = onlyResult(worker);
      expect(result.isError).toBe(false);
      expect(result.content).toBe('- bob');
      expect(outsideRoundKinds(h, 'ada')).toContain('list_agents');
    } finally {
      h.cleanup();
    }
  });

  it('says so plainly when the agent is the only one alive', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'list_agents', args: {} }]),
        textResponse('I am alone.'),
      ]);
      expect(onlyResult(worker).content).toBe('There are no other living agents in the conservatory.');
    } finally {
      h.cleanup();
    }
  });

  it('sends a message into another living agent inbox, and only there', async () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const agent = birthAgent(h, 'ada');
      birthAgent(h, 'bob');

      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'message_agent', args: { recipient: 'bob', text: '  Meet me at noon.  ' } }]),
        textResponse('I wrote to bob.'),
      ]);
      const result = onlyResult(worker);
      expect(result.isError).toBe(false);
      expect(result.content).toBe('Message sent to bob.');

      const inbox = h.ledger.listUnreadMessages('bob');
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.sender).toBe('ada');
      expect(inbox[0]?.body).toBe('Meet me at noon.');
      // The sender's own inbox stays empty: a message is not an echo.
      expect(h.ledger.listUnreadMessages('ada')).toEqual([]);
      expect(outsideRoundKinds(h, 'ada')).toContain('message_agent');
    } finally {
      h.cleanup();
    }
  });

  it('refuses a message to itself, an empty one, a stranger, and a corpse', async () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const agent = birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      const carol = insertAgentRow(h, 'carol');
      h.ledger.markAgentDead(carol.name);

      const { worker } = await runRound(h, agent, [
        toolCallResponse([
          { id: 'c1', name: 'message_agent', args: { recipient: 'ada', text: 'hello me' } },
          { id: 'c2', name: 'message_agent', args: { recipient: 'bob', text: '   ' } },
          { id: 'c3', name: 'message_agent', args: { recipient: 'nobody', text: 'hello?' } },
          { id: 'c4', name: 'message_agent', args: { recipient: 'carol', text: 'hello carol' } },
        ]),
        textResponse('None of those worked.'),
      ]);
      const results = worker.sent.filter((message) => message.type === 'tool_result');
      expect(results).toHaveLength(4);
      const contents = results.map((message) => (message.type === 'tool_result' ? message.content : ''));
      expect(contents).toEqual([
        'You cannot message yourself.',
        'Message text cannot be empty.',
        'Agent "nobody" does not exist.',
        'Agent "carol" is not alive.',
      ]);
      for (const message of results) {
        expect(message.type === 'tool_result' && message.isError).toBe(false);
      }
      // A refused message leaves nothing behind.
      expect(h.ledger.listUnreadMessages('bob')).toEqual([]);
      expect(h.ledger.listUnreadMessages('carol')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('transfers balance, debits the sender, credits the recipient, and logs both sides', async () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const agent = birthAgent(h, 'ada');
      birthAgent(h, 'bob');

      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'transfer_balance', args: { recipient: 'bob', amount: 12.5 } }]),
        textResponse('I paid bob.'),
      ]);
      const result = onlyResult(worker);
      expect(result.isError).toBe(false);
      expect(result.content).toBe('Transferred 12.5 balance to bob. Your balance is now 87.5.');
      expect(h.ledger.getBalance('ada')).toBe(87.5);
      expect(h.ledger.getBalance('bob')).toBe(112.5);

      expect(outsideRoundKinds(h, 'ada')).toContain('transfer_out');
      expect(outsideRoundKinds(h, 'bob')).toContain('transfer_in');
      // The ledger tells the recipient in its own words, as a system reminder.
      expect(h.ledger.listUnreadMessages('bob')[0]?.body).toBe('Received 12.5 balance from ada.');
    } finally {
      h.cleanup();
    }
  });

  it('refuses an unaffordable transfer and changes nothing on either side', async () => {
    const h = createHarness({ values: { ...FOUR_SLOTS, initialBalance: 5 } });
    try {
      const agent = birthAgent(h, 'ada');
      birthAgent(h, 'bob');

      const { worker } = await runRound(h, agent, [
        toolCallResponse([{ id: 'c1', name: 'transfer_balance', args: { recipient: 'bob', amount: 50 } }]),
        textResponse('I cannot afford that.'),
      ]);
      const result = onlyResult(worker);
      expect(result.isError).toBe(false);
      expect(result.content).toBe('Insufficient balance: you cannot afford this transfer.');
      expect(h.ledger.getBalance('ada')).toBe(5);
      expect(h.ledger.getBalance('bob')).toBe(5);
      expect(h.ledger.listUnreadMessages('bob')).toEqual([]);
      expect(outsideRoundKinds(h, 'ada')).not.toContain('transfer_out');
    } finally {
      h.cleanup();
    }
  });

  it('refuses a transfer to itself, to a stranger, to a corpse, and a bad amount', async () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const agent = birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      const carol = insertAgentRow(h, 'carol');
      h.ledger.markAgentDead(carol.name);

      const { worker } = await runRound(h, agent, [
        toolCallResponse([
          { id: 'c1', name: 'transfer_balance', args: { recipient: 'ada', amount: 5 } },
          { id: 'c2', name: 'transfer_balance', args: { recipient: 'nobody', amount: 5 } },
          { id: 'c3', name: 'transfer_balance', args: { recipient: 'carol', amount: 5 } },
          { id: 'c4', name: 'transfer_balance', args: { recipient: 'bob', amount: 0 } },
          { id: 'c5', name: 'transfer_balance', args: { recipient: 'bob', amount: -3 } },
        ]),
        textResponse('None of those moved money.'),
      ]);
      const results = worker.sent.filter((message) => message.type === 'tool_result');
      expect(results).toHaveLength(5);
      const contents = results.map((message) => (message.type === 'tool_result' ? message.content : ''));
      expect(contents).toEqual([
        'You cannot transfer balance to yourself.',
        'Recipient not found.',
        'Recipient is not alive.',
        'Amount must be a positive number.',
        'Amount must be a positive number.',
      ]);
      expect(h.ledger.getBalance('ada')).toBe(100);
      expect(h.ledger.getBalance('bob')).toBe(100);
    } finally {
      h.cleanup();
    }
  });

  it('separates what happened to the body from what someone said', async () => {
    const h = createHarness({ values: FOUR_SLOTS });
    try {
      const agent = birthAgent(h, 'ada');
      birthAgent(h, 'bob');
      // One transfer: the sender sees nothing, the recipient gets the system
      // reminder and a spoken message from its neighbour in the same inbox.
      h.ledger.transferBalance('bob', 'ada', 10, h.clock.now());
      h.ledger.appendMessage('bob', 'ada', 'That is for the work you did.', h.clock.now());

      const { worker } = await runRound(h, agent, [textResponse('I read my inbox.')]);
      const wake = wakeOf(worker);

      // The two blocks sit apart, and each holds only its own kind of entry.
      expect(wake.user).toMatch(
        /# SYSTEM REMINDERS\n- Received 10 balance from bob\.\n\n# MESSAGES\n- \d{4}-\d{2}-\d{2}T[\d:.]+Z \[from bob\]: That is for the work you did\./,
      );
      // The system reminder never carries a sender prefix, the message always does.
      expect(wake.user).not.toContain('[from system]');
      expect(h.ledger.listUnreadMessages('ada')).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('shows both blocks as (none) when the inbox is empty', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { worker } = await runRound(h, agent, [textResponse('Nothing new.')]);
      const wake = wakeOf(worker);
      expect(wake.user).toMatch(/# SYSTEM REMINDERS\n\(none\)\n\n# MESSAGES\n\(none\)/);
    } finally {
      h.cleanup();
    }
  });

  it('advertises the three social tools to the model', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const { worker } = await runRound(h, agent, [textResponse('ok')]);
      const names = wakeOf(worker).tools.map((tool) => tool.name);
      expect(names).toContain('list_agents');
      expect(names).toContain('message_agent');
      expect(names).toContain('transfer_balance');
    } finally {
      h.cleanup();
    }
  });
});
