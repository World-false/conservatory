import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RoundTranscript } from '../src/agent/ipc';
import { agentMemoryPath } from '../src/config';
import {
  consolidateMemory,
  enforceHeader,
  MEMORY_SYSTEM_PROMPT,
  newbornMemory,
  readMemoryFile,
  writeMemoryAtomic,
  type MemoryDeps,
} from '../src/organs/memory';
import { PLACEHOLDER } from '../src/organs/redaction';
import { birthAgent, createHarness, memoryResponse, ScriptedModelClient, textResponse, type Harness } from './helpers';

function transcriptFor(agent: string, at: number): RoundTranscript {
  return {
    roundId: 1,
    agent,
    startedAt: at,
    endedAt: at + 1000,
    endReason: 'final',
    finalReply: 'I checked my body and did nothing else.',
    entries: [
      { kind: 'assistant', content: 'Let me look at my status.' },
      { kind: 'tool_call', callId: 'c1', name: 'get_status', argumentsJson: '{}' },
      { kind: 'tool_result', callId: 'c1', name: 'get_status', content: '{"ok":true}', isError: false },
      { kind: 'assistant', content: 'I checked my body and did nothing else.' },
    ],
  };
}

function depsFor(h: Harness, responses: string[], capChars = 400): { deps: MemoryDeps; errors: string[] } {
  const errors: string[] = [];
  const model = new ScriptedModelClient(responses.map((text) => textResponse(text)));
  return {
    deps: {
      ledger: h.ledger,
      blackbox: h.blackbox,
      paths: h.paths,
      capChars,
      model,
      systemPrompt: MEMORY_SYSTEM_PROMPT,
      now: h.clock.now,
      onError: (agent, message) => {
        errors.push(`${agent}: ${message}`);
      },
    },
    errors,
  };
}

describe('MEMORY shape', () => {
  it('starts as exactly the harness header', () => {
    const born = 1_700_000_000_000;
    expect(newbornMemory('ada', born)).toBe(`Name: ada\nBorn: ${new Date(born).toISOString()}\n`);
  });

  it('restores the header the harness owns, whatever the model produced', () => {
    const born = 1_700_000_000_000;
    const expected = `Name: ada\nBorn: ${new Date(born).toISOString()}`;
    expect(enforceHeader('Name: someone-else\nBorn: 1999-01-01\nI did a thing.', 'ada', born)).toBe(
      `${expected}\nI did a thing.`,
    );
    expect(enforceHeader('i did a thing.', 'ada', born)).toBe(`${expected}\ni did a thing.`);
    expect(enforceHeader('Name: x\nBorn: y\n\n  \nI did a thing.', 'ada', born)).toBe(
      `${expected}\n  \nI did a thing.`,
    );
  });
});

describe('folding a round into MEMORY', () => {
  it('writes the model text with the true header and logs both versions', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const before = readMemoryFile(h.paths, 'ada');
      const { deps } = depsFor(h, [`Name: hijacked\nBorn: 1999-01-01\nI woke up and read my body.`]);

      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('updated');
      const written = readFileSync(agentMemoryPath(h.paths, 'ada'), 'utf8');
      expect(written.startsWith(`Name: ada\nBorn: ${new Date(agent.bornAt).toISOString()}\n`)).toBe(true);
      expect(written).toContain('I woke up and read my body.');
      expect(written).not.toContain('hijacked');

      const rounds = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      const kinds = rounds.map((entry) => entry.kind);
      expect(kinds).toContain('memory_old');
      expect(kinds).toContain('memory_new');
      const oldEntry = rounds.find((entry) => entry.kind === 'memory_old');
      expect(oldEntry?.['text']).toBe(before);
      expect(h.ledger.sumUsage('ada', 'memory').records).toBe(1);
      expect(h.ledger.sumUsage('ada', 'memory').promptTokens).toBe(100);
    } finally {
      h.cleanup();
    }
  });

  it('retries once and accepts the second answer', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const { deps, errors } = depsFor(h, [`x`.repeat(80), 'short and true'], 60);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('updated');
      expect(errors).toEqual([]);
      expect(readFileSync(agentMemoryPath(h.paths, 'ada'), 'utf8')).toContain('short and true');
      expect(h.ledger.sumUsage('ada', 'memory').records).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it('keeps the old MEMORY untouched when two answers are unusable', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const before = readMemoryFile(h.paths, 'ada');
      const { deps, errors } = depsFor(h, ['y'.repeat(80), 'z'.repeat(90)], 60);

      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('rejected');
      expect(readMemoryFile(h.paths, 'ada')).toBe(before);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('kept unchanged');

      const rounds = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.round);
      expect(rounds).toContain(1);
      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      expect(entries.filter((entry) => entry.kind === 'memory_rejected').length).toBe(3);
      expect(entries.some((entry) => entry['keptOldMemory'] === true)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('treats a body-less answer as nothing to remember', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const before = readMemoryFile(h.paths, 'ada');
      const { deps } = depsFor(h, [
        memoryResponse('ada', agent.bornAt).message.content ?? '',
        '',
      ]);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('rejected');
      expect(readMemoryFile(h.paths, 'ada')).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  it('refuses to write anything when the provider reports no usage', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const before = readMemoryFile(h.paths, 'ada');
      const { deps, errors } = depsFor(h, []);
      const model = new ScriptedModelClient([
        { message: { role: 'assistant', content: 'I did a thing.' }, usage: null },
      ]);
      const outcome = await consolidateMemory(
        { ...deps, model },
        transcriptFor('ada', h.clock.now()),
      );
      expect(outcome.status).toBe('usage_missing');
      expect(readMemoryFile(h.paths, 'ada')).toBe(before);
      expect(h.ledger.sumUsage('ada', 'memory').records).toBe(1);
      expect(h.ledger.sumUsage('ada', 'memory').promptTokens).toBe(0);
      expect(errors.length).toBe(1);

      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      expect(entries.some((entry) => entry.kind === 'usage_missing')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('reports a failed model call instead of writing half a memory', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const before = readMemoryFile(h.paths, 'ada');
      const { deps, errors } = depsFor(h, []);
      const model = new ScriptedModelClient([]);
      const outcome = await consolidateMemory(
        { ...deps, model },
        transcriptFor('ada', h.clock.now()),
      );
      expect(outcome.status).toBe('model_error');
      expect(readMemoryFile(h.paths, 'ada')).toBe(before);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('MEMORY model call failed');
    } finally {
      h.cleanup();
    }
  });

  it('feeds the model the current MEMORY and the round, and asks for a cap', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      writeMemoryFileHelper(h, 'I have been here before.');
      const { deps } = depsFor(h, ['I am still here.'], 60);
      await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      const model = deps.model as ScriptedModelClient;
      const request = model.requests[0];
      expect(request).toBeDefined();
      const user = request.messages.find((message) => message.role === 'user');
      expect(user?.content).toContain('I have been here before.');
      expect(user?.content).toContain('get_status');
      expect(user?.content).toContain('at most 60 characters');
      const system = request.messages.find((message) => message.role === 'system');
      expect(system?.content).toContain('first person');
      expect(system?.content).toContain('Do not invent a persona');
    } finally {
      h.cleanup();
    }
  });

  it('puts a frozen sentence back when the model filled the gap in', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
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
      const frozen = `The vault code is ${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER}${PLACEHOLDER} and it matters.`;
      writeMemoryFileHelper(h, `I remember this.\n${frozen}`);

      // The model smooths the gap over instead of leaving it empty.
      const smoothed = `I remember this.\nThe vault code is 9999 and it matters.`;
      const { deps } = depsFor(h, [smoothed], 4000);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('updated');

      const written = readFileSync(agentMemoryPath(h.paths, 'ada'), 'utf8');
      expect(written).toContain(frozen);
      expect(written).not.toContain('9999');

      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      const repair = entries.find((entry) => entry.kind === 'frozen_restored');
      expect(repair).toBeDefined();
      expect(repair?.['replaced']).toEqual([sentenceId]);
    } finally {
      h.cleanup();
    }
  });

  it('deletes a placeholder the model invented where no wound exists', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      writeMemoryFileHelper(h, 'I have been here before.');
      const { deps } = depsFor(h, [`I have been here before.\nI invented a scar: ${PLACEHOLDER}${PLACEHOLDER}.`], 4000);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('updated');
      expect(readMemoryFile(h.paths, 'ada')).not.toContain(PLACEHOLDER);
      expect(readMemoryFile(h.paths, 'ada')).toContain('I invented a scar: .');
    } finally {
      h.cleanup();
    }
  });

  it('never asks the model to preserve a placeholder', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const sentenceId = h.ledger.insertFrozenSentence('ada', 'A lost sentence here.', h.clock.now());
      h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 2,
        length: 4,
        originalText: 'lost',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      writeMemoryFileHelper(h, `A ${PLACEHOLDER.repeat(4)} sentence here.`);
      const { deps } = depsFor(h, ['Something new happened.'], 4000);
      await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));

      const model = deps.model as ScriptedModelClient;
      const system = model.requests[0].messages.find((message) => message.role === 'system')?.content ?? '';
      // The harness restores frozen sentences from the ledger, so the system
      // prompt says nothing about placeholders, scars, or keeping any sentence
      // intact. The current MEMORY is shown as it is, gaps included, because
      // that is what the agent's own record looks like.
      expect(system).not.toContain(PLACEHOLDER);
      expect(system.toLowerCase()).not.toContain('scar');
      expect(system.toLowerCase()).not.toContain('redact');
      expect(system.toLowerCase()).not.toContain('placeholder');
      expect(system.toLowerCase()).not.toContain('frozen');
      expect(system.toLowerCase()).not.toContain('keep it exactly');
    } finally {
      h.cleanup();
    }
  });

  it('measures the restored text against the cap, not the model answer', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const original = 'x'.repeat(30);
      const sentenceId = h.ledger.insertFrozenSentence('ada', original, h.clock.now());
      h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 0,
        length: 30,
        originalText: original,
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      const frozen = PLACEHOLDER.repeat(30);
      writeMemoryFileHelper(h, frozen);
      // A short answer that would fit, but the restored sentence pushes it over.
      const cap = 60;
      const { deps } = depsFor(h, ['Short answer.', 'Fits now.'], cap);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      // Either the retry is accepted or the old MEMORY is kept; what must not
      // happen is a written MEMORY over the cap.
      const written = readMemoryFile(h.paths, 'ada');
      if (outcome.status === 'updated') {
        expect(written.length).toBeLessThanOrEqual(cap);
        expect(written).toContain(frozen);
      } else {
        expect(outcome.status).toBe('rejected');
        expect(written).toContain(frozen);
      }
    } finally {
      h.cleanup();
    }
  });
});

function writeMemoryFileHelper(h: Harness, body: string): void {
  const agent = h.ledger.getAgent('ada');
  if (agent === null) {
    throw new Error('the agent must exist');
  }
  // Building it through the harness header keeps the format honest.
  writeMemoryAtomic(h.paths, 'ada', enforceHeader(body, 'ada', agent.bornAt));
}
