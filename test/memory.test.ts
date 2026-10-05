import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RoundTranscript } from '../src/agent/ipc';
import { agentMemoryPath } from '../src/config';
import {
  consolidateMemory,
  enforceHeader,
  MAX_RECENT_ROUNDS,
  MEMORY_SYSTEM_PROMPT,
  newbornMemory,
  readMemoryFile,
  RECENT_ROUNDS_HEADING,
  WHO_I_AM_HEADING,
  writeMemoryAtomic,
  type MemoryDeps,
} from '../src/organs/memory';
import { PLACEHOLDER, redactOnce, renderSentence, type RedactionDeps } from '../src/organs/redaction';
import { birthAgent, createHarness, memoryResponse, ScriptedModelClient, textResponse, type Harness } from './helpers';

function transcriptFor(agent: string, at: number, roundId = 1): RoundTranscript {
  return {
    roundId,
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

function depsFor(h: Harness, responses: string[], capChars = 4000): { deps: MemoryDeps; errors: string[] } {
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

/** The round count of a file, which is also its `## Round` heading count. */
function roundCount(text: string): number {
  return (text.match(/^## Round /gm) ?? []).length;
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

  it('creates both sections on a newborn, then only ever adds to the end', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const firstAt = h.clock.now();
      const { deps } = depsFor(h, ['I woke up and read my body.', 'I looked at the sky.']);

      await consolidateMemory(deps, transcriptFor('ada', firstAt, 1));
      const afterFirst = readMemoryFile(h.paths, 'ada');
      expect(afterFirst).toContain(WHO_I_AM_HEADING);
      expect(afterFirst).toContain(RECENT_ROUNDS_HEADING);
      expect(afterFirst).toContain(`## Round 1 — ${new Date(firstAt).toISOString()}`);
      expect(afterFirst.indexOf(WHO_I_AM_HEADING)).toBeLessThan(afterFirst.indexOf(RECENT_ROUNDS_HEADING));

      h.clock.advanceSeconds(60);
      const secondAt = h.clock.now();
      await consolidateMemory(deps, transcriptFor('ada', secondAt, 2));
      const afterSecond = readMemoryFile(h.paths, 'ada');
      // Append touches nothing that was already written: the old file is a
      // prefix of the new one, and the round is the block on its end.
      expect(afterSecond.startsWith(afterFirst.replace(/\s+$/u, ''))).toBe(true);
      expect(afterSecond).toContain(`## Round 2 — ${new Date(secondAt).toISOString()}`);
      expect(afterSecond.indexOf('## Round 1')).toBeLessThan(afterSecond.indexOf('## Round 2'));
      expect(roundCount(afterSecond)).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it('writes the round instant the transcript carries, never one the model guessed', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const at = h.clock.now();
      const { deps } = depsFor(h, [`## Round 7 — 1999-01-01T00:00:00.000Z\nI woke up and read my body.`]);

      await consolidateMemory(deps, transcriptFor('ada', at, 7));
      const written = readMemoryFile(h.paths, 'ada');
      expect(written).toContain(`## Round 7 — ${new Date(at).toISOString()}`);
      expect(written).not.toContain('1999-01-01');
    } finally {
      h.cleanup();
    }
  });

  it('refuses an answer that rewrites the whole file instead of one round', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const before = readMemoryFile(h.paths, 'ada');
      const dump = [
        `Name: ada`,
        `Born: ${new Date(agent.bornAt).toISOString()}`,
        WHO_I_AM_HEADING,
        'I am ada.',
        RECENT_ROUNDS_HEADING,
        '## Round 1 — 1999-01-01T00:00:00.000Z',
        'I woke up.',
      ].join('\n');
      const { deps, errors } = depsFor(h, [dump, dump]);

      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('rejected');
      expect(readMemoryFile(h.paths, 'ada')).toBe(before);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('kept unchanged');
    } finally {
      h.cleanup();
    }
  });

  it('retries once and accepts the second answer', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const { deps, errors } = depsFor(h, ['', 'short and true']);
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
      const { deps, errors } = depsFor(h, ['   ', '']);

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

  it('feeds the model the current MEMORY and the round, and asks for one block', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      writeMemoryFileHelper(h, 'I have been here before.');
      const { deps } = depsFor(h, ['I am still here.']);
      await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      const model = deps.model as ScriptedModelClient;
      const request = model.requests[0];
      expect(request).toBeDefined();
      const user = request.messages.find((message) => message.role === 'user');
      expect(user?.content).toContain('I have been here before.');
      expect(user?.content).toContain('get_status');
      expect(user?.content).toContain('APPEND');
      expect(user?.content).toContain('Do not write a heading');
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

      // The model smooths the gap over instead of leaving it empty, and writes
      // the round as one paragraph the way the prompt asks it to.
      const smoothed = `I remember this. The vault code is 9999 and it matters.`;
      const { deps } = depsFor(h, [smoothed], 4000);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('updated');

      const written = readFileSync(agentMemoryPath(h.paths, 'ada'), 'utf8');
      expect(written).toContain(frozen);
      expect(written).not.toContain('9999');
      // The rest of the paragraph survives: only the echo is dropped.
      expect(written).toContain('I remember this.');

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

  it('never lets the redacted original reach the model', async () => {
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
      const visible = renderSentence(original, h.ledger.listWounds('ada'));
      writeMemoryFileHelper(h, `I remember this.\n${visible}`);

      const { deps } = depsFor(h, ['Something new happened.'], 4000);
      await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));

      // The model reads the wound's visible form and nothing else; the true
      // text lives in the ledger and the black box, out of its reach.
      const model = deps.model as ScriptedModelClient;
      expect(model.requests.length).toBeGreaterThan(0);
      for (const request of model.requests) {
        for (const message of request.messages) {
          expect(message.content ?? '').not.toContain('4471');
        }
        const user = request.messages.find((message) => message.role === 'user');
        expect(user?.content).toContain(visible);
      }
    } finally {
      h.cleanup();
    }
  });

  it('tells the model to leave a placeholder sentence exactly as it stands', async () => {
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
      // The prompt asks the model to leave a wounded sentence alone. That ask is
      // a courtesy, not the guarantee: the harness never folds a block holding a
      // placeholder and restores every frozen sentence from the ledger, so the
      // promise does not rest on the model obeying.
      expect(system).toContain(PLACEHOLDER);
      expect(system.toLowerCase()).toContain('placeholder');
      expect(system.toLowerCase()).not.toContain('redact');
    } finally {
      h.cleanup();
    }
  });

  it('writes the round even when the file outgrows the cap, and tells the operator', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const { deps } = depsFor(h, ['I woke up and read my body.'], 40);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('updated');
      const written = readMemoryFile(h.paths, 'ada');
      expect(written).toContain('I woke up and read my body.');
      expect(written.length).toBeGreaterThan(40);
      const kinds = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries.map((entry) => entry.kind));
      expect(kinds).toContain('memory_over_cap');
    } finally {
      h.cleanup();
    }
  });

  it('files what a file from an older version already held under the long-term part', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      writeMemoryFileHelper(h, 'I have been here before.');
      const { deps } = depsFor(h, ['I am still here.']);
      await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));

      const written = readMemoryFile(h.paths, 'ada');
      expect(written).toContain(WHO_I_AM_HEADING);
      const old = written.indexOf('I have been here before.');
      expect(old).toBeGreaterThan(written.indexOf(WHO_I_AM_HEADING));
      expect(old).toBeLessThan(written.indexOf(RECENT_ROUNDS_HEADING));
      expect(written).toContain('I am still here.');
      expect(written).toContain('## Round 1 — ');
    } finally {
      h.cleanup();
    }
  });
});

describe('living with redaction', () => {
  it('leaves every frozen sentence exactly as the ledger renders it, round after round', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const responses = Array.from({ length: 60 }, (_, index) => `I lived round ${index + 1}.`);
      const { deps } = depsFor(h, responses);
      const redaction: RedactionDeps = {
        ledger: h.ledger,
        values: h.values,
        blackbox: h.blackbox,
        now: h.clock.now,
        readMemory: (name) => readMemoryFile(h.paths, name),
        writeMemory: (name, text) => writeMemoryAtomic(h.paths, name, text),
        random: () => 0.5,
      };

      let woundedAtLeastOnce = false;
      for (let round = 1; round <= 12; round += 1) {
        h.clock.advanceSeconds(60);
        for (let tick = 1; tick <= 2; tick += 1) {
          redactOnce(redaction, 'ada', 0, (round - 1) * 2 + tick);
        }
        const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), round));
        expect(outcome.status).toBe('updated');

        // The invariant the whole mechanism exists to keep: whatever the memory
        // system did, every frozen sentence still reads exactly as the ledger
        // says it should, gaps and all.
        const written = readMemoryFile(h.paths, 'ada');
        const wounds = h.ledger.listWounds('ada');
        for (const sentence of h.ledger.listActiveFrozenSentences('ada')) {
          const mine = wounds.filter((wound) => wound.sentenceId === sentence.id);
          const visible = renderSentence(sentence.original, mine);
          expect(written).toContain(visible);
          woundedAtLeastOnce = true;
        }
      }
      expect(woundedAtLeastOnce).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('the round limit', () => {
  it('does not compact while the rounds still fit', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const responses = Array.from({ length: MAX_RECENT_ROUNDS }, (_, index) => `Round ${index + 1} note.`);
      const { deps } = depsFor(h, responses);
      for (let round = 1; round <= MAX_RECENT_ROUNDS; round += 1) {
        h.clock.advanceSeconds(60);
        const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), round));
        expect(outcome.status).toBe('updated');
      }
      const written = readMemoryFile(h.paths, 'ada');
      expect(roundCount(written)).toBe(MAX_RECENT_ROUNDS);
      // One call per round and no more: a compaction would have shown up here.
      expect(h.ledger.sumUsage('ada', 'memory').records).toBe(MAX_RECENT_ROUNDS);
      expect(deps.model).toBeDefined();
    } finally {
      h.cleanup();
    }
  });

  it('folds the oldest rounds into the long-term part and keeps the newest ten', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const responses: string[] = [];
      for (let round = 1; round <= MAX_RECENT_ROUNDS + 1; round += 1) {
        responses.push(`note ${round}`);
      }
      responses.push('I have lived eleven rounds.');
      responses.push('note 12');
      responses.push('I have lived twelve rounds.');
      const { deps } = depsFor(h, responses);

      let last = '';
      for (let round = 1; round <= MAX_RECENT_ROUNDS + 2; round += 1) {
        h.clock.advanceSeconds(60);
        const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), round));
        expect(outcome.status).toBe('updated');
        last = outcome.status === 'updated' ? outcome.memory : last;
      }

      expect(roundCount(last)).toBe(MAX_RECENT_ROUNDS);
      expect(last).toContain('I have lived twelve rounds.');
      // The two oldest rounds were folded away; the ten that stay are verbatim.
      expect(last).not.toContain('note 1\n');
      expect(last).not.toContain('note 2\n');
      expect(last).toContain('note 3');
      expect(last).toContain('note 12');

      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      expect(entries.some((entry) => entry.kind === 'memory_compacted')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('never folds a round that still holds a placeholder', async () => {
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
      const visible = renderSentence(original, h.ledger.listWounds('ada'));
      const blocks = [{ body: visible }, ...Array.from({ length: 10 }, (_, index) => ({ body: `note ${index + 2}` }))];
      writeCanonicalMemory(h, blocks);

      const { deps } = depsFor(h, ['note 12', 'I folded one clean note.']);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), 12));
      expect(outcome.status).toBe('updated');
      const written = outcome.status === 'updated' ? outcome.memory : '';

      // The block that carries the wound is still there, character for
      // character, and the ledger still renders it the same way.
      expect(written).toContain(visible);
      expect(renderSentence(original, h.ledger.listWounds('ada'))).toBe(visible);
      expect(written).toContain('## Round 1 — ');
      expect(written).toContain('I folded one clean note.');
      // The oldest clean block past it was folded instead.
      expect(written).not.toContain('note 2\n');
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(4);
      expect(roundCount(written)).toBe(MAX_RECENT_ROUNDS + 1);
    } finally {
      h.cleanup();
    }
  });

  it('puts a frozen sentence the compaction dropped back, from the ledger', async () => {
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
      const visible = renderSentence(original, h.ledger.listWounds('ada'));
      const blocks = Array.from({ length: 11 }, (_, index) => ({ body: `note ${index + 1}` }));
      writeCanonicalMemory(h, blocks, `I remember this.\n${visible}`);

      // The compaction answer simply forgets the wounded sentence.
      const { deps } = depsFor(h, ['note 12', 'I still remember the vault.']);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), 12));
      expect(outcome.status).toBe('updated');
      const written = outcome.status === 'updated' ? outcome.memory : '';

      expect(written).toContain(visible);
      expect(renderSentence(original, h.ledger.listWounds('ada'))).toBe(visible);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(4);
      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      expect(entries.some((entry) => entry.kind === 'frozen_restored')).toBe(true);
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

/** A file already in the two-section shape, so a test can start mid-life. */
function writeCanonicalMemory(h: Harness, blocks: { body: string }[], who = ''): void {
  const agent = h.ledger.getAgent('ada');
  if (agent === null) {
    throw new Error('the agent must exist');
  }
  const lines = [`Name: ada`, `Born: ${new Date(agent.bornAt).toISOString()}`, '', WHO_I_AM_HEADING];
  if (who !== '') {
    lines.push(who);
  }
  lines.push('', RECENT_ROUNDS_HEADING);
  blocks.forEach((block, index) => {
    lines.push('', `## Round ${index + 1} — ${new Date(h.clock.now() + index * 1000).toISOString()}`, block.body);
  });
  writeMemoryAtomic(h.paths, 'ada', `${lines.join('\n')}\n`);
}
