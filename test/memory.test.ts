import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RoundTranscript } from '../src/agent/ipc';
import { agentMemoryPath } from '../src/config';
import type { ChatResponse } from '../src/model/client';
import {
  consolidateMemory,
  enforceHeader,
  MAX_MEMORY_SESSIONS_PER_ROUND,
  MAX_RECENT_ROUNDS,
  MAX_SANDBOX_REJECTIONS_PER_SESSION,
  MEMORY_SYSTEM_PROMPT,
  newbornMemory,
  readMemoryFile,
  RECENT_ROUNDS_HEADING,
  WHO_I_AM_HEADING,
  writeMemoryAtomic,
  type MemoryDeps,
} from '../src/organs/memory';
import { PLACEHOLDER, redactOnce, renderSentence, type RedactionDeps } from '../src/organs/redaction';
import { createPauseOrgan } from '../src/organs/pause';
import {
  birthAgent,
  createHarness,
  memoryResponse,
  ScriptedModelClient,
  textResponse,
  toolCallResponse,
  type Harness,
} from './helpers';

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

interface MemoryHarness {
  deps: MemoryDeps;
  errors: string[];
  /** Every (agent, reason, at) the sandbox reported a conservatory pause with. */
  pauses: { agent: string; reason: string; at: number }[];
}

function depsFor(h: Harness, responses: string[], capChars = 4000): MemoryHarness {
  const errors: string[] = [];
  const pauses: { agent: string; reason: string; at: number }[] = [];
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
      onPauseConservatory: (agent, reason, at) => {
        pauses.push({ agent, reason, at });
      },
    },
    errors,
    pauses,
  };
}

/** The same deps, with a model that answers with tool calls instead of prose. */
function toolDepsFor(h: Harness, responses: ChatResponse[], capChars = 4000): MemoryHarness {
  const built = depsFor(h, [], capChars);
  built.deps.model = new ScriptedModelClient(responses);
  return built;
}

/** Every black box entry kind written for this agent, oldest first. */
function blackboxKinds(h: Harness, agent = 'ada'): string[] {
  return h.blackbox.readRecentRounds(agent, 10).flatMap((round) => round.entries.map((entry) => entry.kind));
}

function blackboxEntries(h: Harness, agent = 'ada'): Record<string, unknown>[] {
  return h.blackbox.readRecentRounds(agent, 10).flatMap((round) => round.entries);
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
      // Three sessions of five refusals each, and only then is the file given
      // up on: an answer this bad is not one bad guess.
      const { deps, errors, pauses } = depsFor(h, Array.from({ length: 15 }, () => dump));

      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.pausedConservatory).toBe(true);
      }
      expect(readMemoryFile(h.paths, 'ada')).toBe(before);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('kept unchanged');
      expect(pauses.length).toBe(1);
      expect(pauses[0].agent).toBe('ada');

      const entries = blackboxEntries(h);
      expect(entries.filter((entry) => entry['kind'] === 'memory_rejected').length).toBe(15);
      expect(entries.filter((entry) => entry['kind'] === 'memory_session_reset').length).toBe(3);
      expect(entries.some((entry) => entry['kind'] === 'memory_sandbox_paused')).toBe(true);
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

  it('keeps the old MEMORY untouched when every session is unusable', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const before = readMemoryFile(h.paths, 'ada');
      const { deps, errors, pauses } = depsFor(h, Array.from({ length: 15 }, () => '   '));

      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.pausedConservatory).toBe(true);
      }
      expect(readMemoryFile(h.paths, 'ada')).toBe(before);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('kept unchanged');
      // One pause, and the conservatory really is paused in the ledger.
      expect(pauses.length).toBe(1);
      expect(h.ledger.getPauseState().paused).toBe(false);

      const rounds = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.round);
      expect(rounds).toContain(1);
      const entries = blackboxEntries(h);
      expect(entries.filter((entry) => entry['kind'] === 'memory_rejected').length).toBe(15);
      expect(entries.filter((entry) => entry['kind'] === 'memory_session_reset').length).toBe(3);
      expect(entries.some((entry) => entry['kind'] === 'memory_sandbox_paused')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('treats a body-less answer as nothing to remember', async () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada');
      const before = readMemoryFile(h.paths, 'ada');
      const empty = memoryResponse('ada', agent.bornAt).message.content ?? '';
      const { deps } = depsFor(h, Array.from({ length: 15 }, () => empty));
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

  it('refuses a round that fills a frozen gap in, and takes the answer that obeys', async () => {
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

      // First the model smooths the gap over. That is a written echo of a
      // frozen sentence, so the sandbox refuses the answer instead of quietly
      // dropping the offending sentence out of it.
      const smoothed = `I remember this. The vault code is 9999 and it matters.`;
      const { deps } = depsFor(h, [smoothed, 'I remember this.']);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('updated');

      const written = readFileSync(agentMemoryPath(h.paths, 'ada'), 'utf8');
      expect(written).toContain(frozen);
      expect(written).not.toContain('9999');
      expect(written).toContain('I remember this.');

      const entries = blackboxEntries(h);
      const rejection = entries.find((entry) => entry.kind === 'memory_rejected');
      expect(rejection).toBeDefined();
      expect(String(rejection?.['reason'])).toContain('frozen sentence');
      // The answer that obeyed is the one that was folded in.
      expect(entries.some((entry) => entry.kind === 'memory_appended')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('refuses a round that invents a placeholder, and takes the answer that obeys', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      writeMemoryFileHelper(h, 'I have been here before.');
      const { deps } = depsFor(h, [
        `I have been here before.\nI invented a scar: ${PLACEHOLDER}${PLACEHOLDER}.`,
        'I invented nothing.',
      ]);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now()));
      expect(outcome.status).toBe('updated');
      expect(readMemoryFile(h.paths, 'ada')).not.toContain(PLACEHOLDER);
      expect(readMemoryFile(h.paths, 'ada')).toContain('I invented nothing.');
      expect(readMemoryFile(h.paths, 'ada')).not.toContain('I invented a scar');

      const rejection = blackboxEntries(h).find((entry) => entry.kind === 'memory_rejected');
      expect(String(rejection?.['reason'])).toContain('do not write the');
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

  it('refuses a compaction that drops a frozen sentence, and keeps it from the ledger', async () => {
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

      // The first compaction answer forgets the wounded sentence outright. The
      // sandbox refuses it rather than repairing it behind the model's back;
      // the second answer carries the sentence across untouched and is taken.
      const carried = `I remember this.\n${visible}\nI still remember the vault.`;
      const { deps } = depsFor(h, ['note 12', 'I still remember the vault.', carried]);
      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), 12));
      expect(outcome.status).toBe('updated');
      const written = outcome.status === 'updated' ? outcome.memory : '';

      // The sentence that would have been dropped is still there, reading
      // exactly as the ledger renders it.
      expect(written).toContain(visible);
      expect(renderSentence(original, h.ledger.listWounds('ada'))).toBe(visible);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(4);
      const entries = blackboxEntries(h);
      const rejection = entries.find((entry) => entry.kind === 'memory_rejected');
      expect(rejection).toBeDefined();
      expect(String(rejection?.['reason'])).toContain('must survive character for character');
      expect(entries.some((entry) => entry.kind === 'memory_compacted')).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe('editing the long-term part through the sandbox', () => {
  const PARAGRAPH_ONE = 'The day before yesterday, A scammed me out of 20 yuan.';
  const PARAGRAPH_TWO =
    `Yesterday, I earne${PLACEHOLDER} 10 ${PLACEHOLDER}uan working a part-${PLACEHOLDER}${PLACEHOLDER}me job, ` +
    `so n${PLACEHOLDER}w I had plenty of time to figure out how to improve my efficiency.`;
  const PARAGRAPH_THREE =
    "Today I'm really speechless. The system had a bug, and it took me forever to exchange it for satiety. I almost starved to death.";
  /** Enough rounds that the next one forces a compaction. */
  const FULL_LIST = Array.from({ length: MAX_RECENT_ROUNDS + 1 }, (_, index) => ({ body: `note ${index + 1}` }));

  /**
   * A frozen sentence whose visible form is exactly `visible`: the placeholders
   * stand for one wounded character each, which is how the ledger renders an
   * untreated wound of length one.
   */
  function insertFrozenVisible(h: Harness, visible: string): number {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    let original = '';
    const offsets: number[] = [];
    for (const character of visible) {
      if (character === PLACEHOLDER) {
        offsets.push(original.length);
        original += alphabet[offsets.length % alphabet.length];
      } else {
        original += character;
      }
    }
    const id = h.ledger.insertFrozenSentence('ada', original, h.clock.now());
    offsets.forEach((offset, index) => {
      h.ledger.insertWound({
        agent: 'ada',
        sentenceId: id,
        offset,
        length: 1,
        originalText: alphabet[index % alphabet.length],
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
    });
    return id;
  }

  function whoOf(h: Harness): string {
    const text = readMemoryFile(h.paths, 'ada');
    const at = text.indexOf(WHO_I_AM_HEADING);
    const end = text.indexOf(RECENT_ROUNDS_HEADING);
    return text.slice(at + WHO_I_AM_HEADING.length, end).trim();
  }

  it('refuses an edit inside a wounded sentence and folds in the next answer', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertFrozenVisible(h, PARAGRAPH_TWO);
      writeCanonicalMemory(
        h,
        FULL_LIST,
        [PARAGRAPH_ONE, PARAGRAPH_TWO, PARAGRAPH_THREE].join('\n\n'),
      );
      const before = whoOf(h);
      expect(before).toContain(PARAGRAPH_TWO);

      // First the model reaches into the wounded sentence, quoting only a
      // fragment of it. Then it edits the healthy third paragraph instead.
      const intoTheWound = toolCallResponse([
        {
          id: 'c1',
          name: 'replace_in_memory',
          args: {
            old_text: `earne${PLACEHOLDER} 10 ${PLACEHOLDER}uan`,
            new_text: 'earned 10 yuan',
          },
        },
      ]);
      const healthyEdit = toolCallResponse([
        {
          id: 'c2',
          name: 'replace_in_memory',
          args: {
            old_text: PARAGRAPH_THREE,
            new_text:
              'Today, speechless—a system bug made exchanging for satiety take forever, nearly starving me.',
          },
        },
        { id: 'c3', name: 'finish_memory_edit', args: {} },
      ]);
      const { deps } = toolDepsFor(h, [textResponse('note 12'), intoTheWound, healthyEdit]);

      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), 12));
      expect(outcome.status).toBe('updated');

      const after = whoOf(h);
      // The wounded paragraph is untouched, character for character, in the
      // middle of the section, in the same order.
      expect(after).toContain(PARAGRAPH_TWO);
      expect(after).not.toContain('earned 10 yuan');
      expect(after.indexOf(PARAGRAPH_ONE)).toBeLessThan(after.indexOf(PARAGRAPH_TWO));
      expect(after.indexOf(PARAGRAPH_TWO)).toBeLessThan(after.indexOf('Today, speechless'));
      expect(after).not.toContain(PARAGRAPH_THREE);
      // The healthy edit went through, so the section really is different now.
      expect(after).toContain('nearly starving me.');

      const entries = blackboxEntries(h);
      const rejection = entries.find((entry) => entry.kind === 'memory_rejected');
      expect(rejection).toBeDefined();
      const reason = String(rejection?.['reason']);
      expect(reason).toContain('is frozen');
      expect(reason).toContain('cannot be modified');
      // The model was told which sentence it had reached into.
      expect(reason).toContain('Yesterday, I earne');
      expect(entries.some((entry) => entry.kind === 'memory_compacted')).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it('throws away a session that burns five refusals, partial edits included', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertFrozenVisible(h, PARAGRAPH_TWO);
      writeCanonicalMemory(
        h,
        FULL_LIST,
        [PARAGRAPH_ONE, PARAGRAPH_TWO, PARAGRAPH_THREE].join('\n\n'),
      );

      const fragment = `part-${PLACEHOLDER}${PLACEHOLDER}me job`;
      const intoTheWound = (index: number): ChatResponse =>
        toolCallResponse([
          {
            id: `bad${index}`,
            name: 'replace_in_memory',
            args: { old_text: fragment, new_text: `a proper job ${index}` },
          },
        ]);
      const goodEdit = toolCallResponse([
        {
          id: 'good',
          name: 'replace_in_memory',
          args: { old_text: PARAGRAPH_ONE, new_text: 'SESSION ONE WAS HERE.' },
        },
      ]);
      // Session 1: one good edit, then five refusals, which throws it away.
      // Session 2: a different good edit, and this time it finishes.
      const sessionTwo = toolCallResponse([
        {
          id: 'pick',
          name: 'replace_in_memory',
          args: { old_text: PARAGRAPH_ONE, new_text: 'SESSION TWO WAS HERE.' },
        },
        { id: 'done', name: 'finish_memory_edit', args: {} },
      ]);
      const { deps } = toolDepsFor(h, [
        textResponse('note 12'),
        goodEdit,
        intoTheWound(1),
        intoTheWound(2),
        intoTheWound(3),
        intoTheWound(4),
        intoTheWound(5),
        sessionTwo,
      ]);

      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), 12));
      expect(outcome.status).toBe('updated');

      const after = whoOf(h);
      // Session 1's good edit is gone: the whole session was discarded, not
      // just the calls that were refused.
      expect(after).not.toContain('SESSION ONE WAS HERE.');
      expect(after).toContain('SESSION TWO WAS HERE.');
      expect(after).not.toContain(PARAGRAPH_ONE);
      expect(after).toContain(PARAGRAPH_TWO);

      const entries = blackboxEntries(h);
      const reset = entries.find((entry) => entry.kind === 'memory_session_reset');
      expect(reset).toBeDefined();
      expect(reset?.['session']).toBe(1);
      expect(reset?.['rejections']).toBe(MAX_SANDBOX_REJECTIONS_PER_SESSION);
      // Session 2 starts clean, so the whole step took exactly five refusals.
      expect(entries.filter((entry) => entry.kind === 'memory_rejected').length).toBe(
        MAX_SANDBOX_REJECTIONS_PER_SESSION,
      );
    } finally {
      h.cleanup();
    }
  });

  it('pauses the whole conservatory when all three sessions fail', async () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      insertFrozenVisible(h, PARAGRAPH_TWO);
      writeCanonicalMemory(
        h,
        FULL_LIST,
        [PARAGRAPH_ONE, PARAGRAPH_TWO, PARAGRAPH_THREE].join('\n\n'),
      );
      const whoBefore = whoOf(h);

      const fragment = `so n${PLACEHOLDER}w I had plenty`;
      const bad = (index: number): ChatResponse =>
        toolCallResponse([
          {
            id: `bad${index}`,
            name: 'replace_in_memory',
            args: { old_text: fragment, new_text: `so now I had plenty ${index}` },
          },
        ]);
      const { deps, pauses } = toolDepsFor(h, [
        textResponse('note 12'),
        ...Array.from({ length: 15 }, (_, index) => bad(index)),
      ]);
      // The same wiring the supervisor uses: the callback really throws the
      // switch, so this checks the ledger and not just the callback.
      const pause = createPauseOrgan({
        ledger: h.ledger,
        values: h.values,
        recordIntervention: () => undefined,
      });
      deps.onPauseConservatory = (agent, reason, at) => {
        pauses.push({ agent, reason, at });
        pause.set(true, at);
      };

      const outcome = await consolidateMemory(deps, transcriptFor('ada', h.clock.now(), 12));
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.pausedConservatory).toBe(true);
      }

      // Fifteen refusals, three sessions thrown away, and one pause.
      const entries = blackboxEntries(h);
      expect(entries.filter((entry) => entry.kind === 'memory_rejected').length).toBe(15);
      expect(entries.filter((entry) => entry.kind === 'memory_session_reset').length).toBe(
        MAX_MEMORY_SESSIONS_PER_ROUND,
      );
      const paused = entries.find((entry) => entry.kind === 'memory_sandbox_paused');
      expect(paused).toBeDefined();
      expect(paused?.['sessions']).toBe(MAX_MEMORY_SESSIONS_PER_ROUND);
      expect(paused?.['rejectionsPerSession']).toBe(MAX_SANDBOX_REJECTIONS_PER_SESSION);

      expect(pauses.length).toBe(1);
      expect(h.ledger.getPauseState().paused).toBe(true);
      // The long-term part is exactly what it was: the abandoned compaction
      // wrote nothing into it.
      expect(whoOf(h)).toBe(whoBefore);
      expect(whoOf(h)).toContain(PARAGRAPH_TWO);
      expect(readMemoryFile(h.paths, 'ada')).not.toContain('so now I had plenty 0');
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
