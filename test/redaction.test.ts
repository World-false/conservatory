import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentHomeDir, type ConservatoryValues } from '../src/config';
import { RoundCoordinator } from '../src/supervisor/round';
import { birthAgent, createHarness, InProcessWorker, memoryResponse, ScriptedModelClient, testPrompts, testSandboxPolicy, testValues, textResponse, toolCallResponse, type Harness } from './helpers';
import type { FrozenSentenceRecord, WoundRecord } from '../src/organs/ledger';
import { createPauseOrgan } from '../src/organs/pause';
import { readMemoryFile, writeMemoryAtomic } from '../src/organs/memory';
import { readNotebookFile, writeNotebookFile } from '../src/organs/notebook';
import {
  activeFrozenFor,
  dueTicks,
  PLACEHOLDER,
  planRedaction,
  redactAgent,
  redactOnce,
  renderSentence,
  sentenceUnits,
  similarity,
  starvationSinceOf,
  type ActiveFrozen,
  type Range,
  type RedactionDeps,
} from '../src/organs/redaction';

function woundAt(offset: number, length: number, status: WoundRecord['status']): WoundRecord {
  return {
    id: offset + 1,
    agent: 'ada',
    sentenceId: 1,
    offset,
    length,
    originalText: 'x'.repeat(length),
    status,
    starvationSince: 0,
    tickIndex: 1,
    createdAt: 0,
    treatedAt: null,
  };
}

function sentence(id: number, original: string): FrozenSentenceRecord {
  return { id, agent: 'ada', original, createdAt: 0, releasedAt: null };
}

/** A random source that always answers the same number. */
function fixed(value: number): () => number {
  return () => value;
}

/** A random source that walks a list and then repeats its last value. */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

function depsFor(h: Harness, random: () => number): RedactionDeps {
  return {
    ledger: h.ledger,
    values: h.values,
    blackbox: h.blackbox,
    now: h.clock.now,
    readMemory: (name) => readMemoryFile(h.paths, name),
    writeMemory: (name, text) => writeMemoryAtomic(h.paths, name, text),
    random,
  };
}

const HEADER = 'Name: ada\nBorn: 2023-11-14T22:13:20.000Z';

function body(...lines: string[]): string {
  return `${HEADER}\n${lines.join('\n')}`;
}

describe('rendering a sentence from the ledger', () => {
  it('turns every untreated character into a placeholder', () => {
    expect(renderSentence('xa', [woundAt(0, 2, 'untreated')])).toBe(`${PLACEHOLDER}${PLACEHOLDER}`);
  });

  it('frames every restored character when the wound is scarred', () => {
    expect(renderSentence('xa', [woundAt(0, 2, 'scarred')])).toBe(
      `${PLACEHOLDER}(x)${PLACEHOLDER}(a)${PLACEHOLDER}`,
    );
  });

  it('leaves no trace at all when the wound is healed', () => {
    expect(renderSentence('xa', [woundAt(0, 2, 'healed')])).toBe('xa');
  });

  it('applies several wounds without shifting the earlier ones', () => {
    expect(renderSentence('abcdef', [woundAt(1, 2, 'untreated'), woundAt(4, 1, 'healed')])).toBe(
      `a${PLACEHOLDER}${PLACEHOLDER}de${'f'}`,
    );
  });

  it('renders the spaces and the punctuation inside a wound too', () => {
    expect(renderSentence('a b', [woundAt(1, 2, 'untreated')])).toBe(`a${PLACEHOLDER}${PLACEHOLDER}`);
  });
});

describe('choosing where a wound lands', () => {
  const values = testValues({
    redactionCharsPerTick: 6,
    redactionMinRanges: 2,
    redactionMaxRanges: 2,
  });

  function prefixes(text: string): Range[] {
    const out: Range[] = [];
    for (const match of text.matchAll(/^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/gm)) {
      const start = match.index;
      out.push({ start, end: start + match[0].length });
    }
    return out;
  }

  function overlaps(left: Range, right: Range): boolean {
    return left.start < right.end && right.start < left.end;
  }

  it('never touches the two header lines, a line break, or a markdown prefix', () => {
    const text = body('', '# A heading here', '- a bullet item here', 'Plain sentence one. Plain sentence two.');
    const wounds = planRedaction(text, [], values, fixed(0));
    expect(wounds.length).toBeGreaterThan(0);
    const boundary = text.indexOf('\n', text.indexOf('\n') + 1);
    const guard = [...prefixes(text)];
    for (const wound of wounds) {
      const range = { start: wound.visibleStart, end: wound.visibleStart + wound.length };
      expect(range.start).toBeGreaterThan(boundary);
      expect(text.slice(range.start, range.end)).not.toMatch(/[\n\r]/);
      for (const prefix of guard) {
        expect(overlaps(range, prefix)).toBe(false);
      }
    }
  });

  it('never crosses a sentence boundary', () => {
    const text = body('Alpha one. Bravo two. Charlie three.');
    const units = sentenceUnits(text, []);
    for (const wound of planRedaction(text, [], values, fixed(0))) {
      const unit = units.find((candidate) => candidate.start === wound.unit.start);
      expect(unit).toBeDefined();
      expect(wound.visibleStart).toBeGreaterThanOrEqual(unit?.start ?? 0);
      expect(wound.visibleStart + wound.length).toBeLessThanOrEqual(unit?.end ?? 0);
    }
  });

  it('takes exactly the configured characters in the configured number of ranges', () => {
    const text = body('Alpha one. Bravo two. Charlie three. Delta four.');
    for (const seed of [0, 0.25, 0.5, 0.75, 0.999]) {
      const wounds = planRedaction(text, [], values, fixed(seed));
      expect(wounds.length).toBe(2);
      const total = wounds.reduce((sum, wound) => sum + wound.length, 0);
      expect(total).toBe(6);
    }
  });

  it('keeps the ranges separate and never inside an existing wound', () => {
    const original = 'Alpha one bravo two charlie three delta four echo five.';
    const record = sentence(1, original);
    const existing = woundAt(2, 3, 'untreated');
    const visible = renderSentence(original, [existing]);
    const text = body(visible);
    const active: ActiveFrozen[] = [{ record, visible, wounds: [existing] }];
    const wounds = planRedaction(text, active, values, sequence([0, 0.5, 0.9, 0, 0, 0.5]));

    const used: Range[] = [];
    for (const wound of wounds) {
      const range = { start: wound.originalOffset, end: wound.originalOffset + wound.length };
      for (const other of used) {
        expect(overlaps(range, other)).toBe(false);
      }
      expect(overlaps(range, { start: 2, end: 5 })).toBe(false);
      used.push(range);
    }
  });

  it('takes the longest run it can when the unit is too short for the ask', () => {
    const values2 = testValues({ redactionCharsPerTick: 20, redactionMinRanges: 1, redactionMaxRanges: 1 });
    const text = body('Short.');
    const wounds = planRedaction(text, [], values2, fixed(0));
    expect(wounds.length).toBe(1);
    expect(wounds[0].length).toBe('Short.'.length);
  });

  it('takes the longest run when only a fragmented piece is left', () => {
    const original = 'abcdefghijklmnop';
    const record = sentence(1, original);
    // Two existing wounds leave three gaps; the widest is 2 characters.
    const existing = [woundAt(5, 3, 'untreated'), woundAt(12, 2, 'scarred')];
    const visible = renderSentence(original, existing);
    const text = body(visible);
    const active: ActiveFrozen[] = [{ record, visible, wounds: existing }];
    const wounds = planRedaction(
      text,
      active,
      testValues({ redactionCharsPerTick: 10, redactionMinRanges: 1, redactionMaxRanges: 1 }),
      fixed(0),
    );
    expect(wounds.length).toBe(1);
    expect(wounds[0].length).toBeLessThanOrEqual(5);
  });

  it('returns nothing when there is nothing left to take', () => {
    const text = body('   ', '\n');
    expect(planRedaction(text, [], values, fixed(0))).toEqual([]);
  });
});

describe('the hunger clock', () => {
  it('derives the moment satiety ran out from the anchor', () => {
    expect(starvationSinceOf({ value: 100, asOf: 0 }, 0.05)).toBe(2_000_000);
    expect(starvationSinceOf({ value: 0, asOf: 1234 }, 0.05)).toBe(1234);
    expect(starvationSinceOf({ value: 50, asOf: 0 }, 0)).toBeNull();
    expect(starvationSinceOf({ value: 50, asOf: 0 }, 0.05)).toBe(1_000_000);
  });

  it('counts the intervals that have passed since then', () => {
    expect(dueTicks(0, 100, 60)).toBe(0);
    expect(dueTicks(100, 100, 60)).toBe(0);
    expect(dueTicks(100 + 60_000, 100, 60)).toBe(1);
    expect(dueTicks(100 + 180_000, 100, 60)).toBe(3);
    expect(dueTicks(100 + 179_999, 100, 60)).toBe(2);
  });
});

describe('one redaction tick', () => {
  it('hides characters in MEMORY, records them, and keeps the original in the black box only', () => {
    const h = createHarness({ values: { redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 } });
    try {
      birthAgent(h, 'ada');
      const secret = 'The vault code is 4471 and it matters.';
      writeMemoryAtomic(h.paths, 'ada', body(secret));
      const deps = depsFor(h, fixed(0));

      const result = redactOnce(deps, 'ada', 1_000, 1);
      expect(result.status).toBe('applied');
      expect(result.wounds.length).toBe(1);
      expect(result.wounds[0].length).toBe(4);
      expect(result.wounds[0].originalText).toBe(secret.slice(0, 4));

      const memory = readMemoryFile(h.paths, 'ada');
      expect(memory).not.toContain(secret.slice(0, 4));
      expect(memory).toContain(PLACEHOLDER.repeat(4));
      expect(memory).toContain(secret.slice(4));

      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      const redaction = entries.find((entry) => entry.kind === 'redaction');
      expect(redaction?.['originalText']).toBe(secret.slice(0, 4));
      expect(redaction?.['sentenceOriginal']).toBe(secret);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(4);
      expect(h.ledger.lifetimeRedactedChars('ada')).toBe(4);
      expect(h.ledger.countAppliedTicks('ada', 1_000)).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('wounds an already frozen sentence again without losing the first wound', () => {
    const h = createHarness({ values: { redactionCharsPerTick: 3, redactionMinRanges: 1, redactionMaxRanges: 1 } });
    try {
      birthAgent(h, 'ada');
      const sentenceText = 'abcdefghijklmnop';
      writeMemoryAtomic(h.paths, 'ada', body(sentenceText));
      const deps = depsFor(h, fixed(0));

      redactOnce(deps, 'ada', 1_000, 1);
      redactOnce(deps, 'ada', 1_000, 2);

      const wounds = h.ledger.listWounds('ada');
      expect(wounds.length).toBe(2);
      expect(wounds[0].originalText).toBe('abc');
      expect(wounds[1].originalText).toBe('def');
      expect(wounds[0].sentenceId).toBe(wounds[1].sentenceId);

      expect(readMemoryFile(h.paths, 'ada')).toBe(body(`${PLACEHOLDER.repeat(6)}ghijklmnop`));
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(6);
    } finally {
      h.cleanup();
    }
  });

  it('records nothing to take when MEMORY is too short, and the newborn does not die', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const deps = depsFor(h, fixed(0));
      const run = redactAgent(deps, 'ada');
      // A newborn with a full anchor is not starving yet, so nothing is owed.
      expect(run.owed).toBe(0);

      // Starve it: the header is shorter than any redaction, so every tick
      // finds nothing to take.
      h.ledger.setSatietyAnchor('ada', 0, h.clock.now());
      h.clock.advanceSeconds(3600);
      const starved = redactAgent(deps, 'ada');
      expect(starved.owed).toBeGreaterThan(0);
      expect(starved.applied).toBe(0);
      expect(starved.skipped).toBe(1);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(0);
      expect(h.ledger.getAgent('ada')?.status).toBe('alive');

      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      const skipped = entries.find((entry) => entry.kind === 'redaction_skipped');
      expect(skipped?.['reason']).toBe('nothing_left');
    } finally {
      h.cleanup();
    }
  });

  it('never takes a character out of the notebook', () => {
    const h = createHarness({ values: { redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 } });
    try {
      birthAgent(h, 'ada');
      writeMemoryAtomic(h.paths, 'ada', body('One sentence that is long enough to wound.'));
      const note = 'The secret in the notebook stays.';
      writeNotebookFile(h.paths, 'ada', 'notes.txt', note);

      redactOnce(depsFor(h, fixed(0)), 'ada', 1_000, 1);
      expect(readNotebookFile(h.paths, 'ada', 'notes.txt')).toBe(note);
    } finally {
      h.cleanup();
    }
  });
});

describe('catching up the redactions a starving agent owes', () => {
  it('applies every interval the wall clock passed and does not double-count', () => {
    const h = createHarness({
      values: { redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 },
    });
    try {
      birthAgent(h, 'ada');
      writeMemoryAtomic(h.paths, 'ada', body('Alpha one bravo two charlie three delta four echo five foxtrot.'));
      const deps = depsFor(h, fixed(0));

      // Satiety 100 at 0.05/s runs out after 2000 seconds.
      h.clock.advanceSeconds(2000 + 3 * 60);
      const first = redactAgent(deps, 'ada');
      expect(first.owed).toBe(3);
      expect(first.applied).toBe(3);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(12);

      const again = redactAgent(deps, 'ada');
      expect(again.owed).toBe(0);
      expect(again.applied).toBe(0);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(12);
    } finally {
      h.cleanup();
    }
  });

  it('starts a new episode after a meal, so the old count stops meaning anything', () => {
    const h = createHarness({
      values: { redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 },
    });
    try {
      birthAgent(h, 'ada');
      writeMemoryAtomic(h.paths, 'ada', body('Alpha one bravo two charlie three delta four echo five foxtrot.'));
      const deps = depsFor(h, fixed(0));

      h.clock.advanceSeconds(2000 + 2 * 60);
      redactAgent(deps, 'ada');
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(8);

      // Eating at the moment satiety hits zero re-anchors the clock.
      h.ledger.setSatietyAnchor('ada', 50, h.clock.now());
      const anchor = h.ledger.getSatietyAnchor('ada');
      expect(anchor).not.toBeNull();
      const starvationSince = starvationSinceOf(anchor as NonNullable<typeof anchor>, h.values.satietyDecayPerSecond);
      expect(starvationSince).toBe(h.clock.now() + 1000 * 1000);

      h.clock.advanceSeconds(1000);
      expect(redactAgent(deps, 'ada').owed).toBe(0);

      h.clock.advanceSeconds(60);
      const owed = redactAgent(deps, 'ada');
      expect(owed.owed).toBe(1);
      expect(owed.applied).toBe(1);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(12);
      expect(h.ledger.countAppliedTicks('ada', starvationSince as number)).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('charges nothing for the time the conservatory was paused', () => {
    const h = createHarness({
      values: { redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 },
    });
    try {
      birthAgent(h, 'ada');
      writeMemoryAtomic(h.paths, 'ada', body('Alpha one bravo two charlie three delta four echo five foxtrot.'));
      const deps = depsFor(h, fixed(0));
      const pause = createPauseOrgan({
        ledger: h.ledger,
        values: h.values,
        recordIntervention: () => undefined,
      });

      h.clock.advanceSeconds(2000 + 5 * 60);
      expect(redactAgent(deps, 'ada').owed).toBe(5);
      // The supervisor skips the redaction beat entirely while paused.
      pause.set(true, h.clock.now());
      h.clock.advanceSeconds(10 * 3600);
      pause.set(false, h.clock.now());

      const anchor = h.ledger.getSatietyAnchor('ada');
      expect(anchor).not.toBeNull();
      const starvationSince = starvationSinceOf(anchor as NonNullable<typeof anchor>, h.values.satietyDecayPerSecond);
      expect(starvationSince).toBe(h.clock.now());
      expect(redactAgent(deps, 'ada').owed).toBe(0);

      h.clock.advanceSeconds(60);
      expect(redactAgent(deps, 'ada').owed).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});

describe('finding the frozen sentences in a MEMORY', () => {
  it('reports the visible text the ledger implies, and nothing else', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const id = h.ledger.insertFrozenSentence('ada', 'The vault code is 4471.', h.clock.now());
      h.ledger.insertWound({
        agent: 'ada',
        sentenceId: id,
        offset: 0,
        length: 3,
        originalText: 'The',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
      writeMemoryAtomic(h.paths, 'ada', body(`${PLACEHOLDER.repeat(3)} vault code is 4471.`));

      const active = activeFrozenFor(h.ledger, 'ada', `${HEADER}\n${PLACEHOLDER.repeat(3)} vault code is 4471.`);
      expect(active.length).toBe(1);
      expect(active[0].visible).toBe(`${PLACEHOLDER.repeat(3)} vault code is 4471.`);
    } finally {
      h.cleanup();
    }
  });
});

describe('placeholder similarity', () => {
  it('ignores the placeholders themselves', () => {
    // Removing the placeholders leaves exactly the same text on both sides.
    expect(similarity('I lost the words here.', `I lost ${PLACEHOLDER}the words here.`)).toBe(1);
    expect(similarity('totally different', 'another thing')).toBeLessThan(0.5);
  });

  it('rates a sentence the model filled in as close to the frozen one', () => {
    expect(similarity('I remember that morning in the garden.', 'I remember ▮▮▮ morning in the garden.')).toBeGreaterThan(
      0.8,
    );
  });
});

describe('the configured values are the ones used', () => {
  it('takes the character count from the config, not from a constant', () => {
    const values: ConservatoryValues = testValues({
      redactionCharsPerTick: 9,
      redactionMinRanges: 1,
      redactionMaxRanges: 1,
    });
    const text = body('Alpha one bravo two charlie three delta four echo five.');
    const wounds = planRedaction(text, [], values, fixed(0));
    expect(wounds.reduce((sum, wound) => sum + wound.length, 0)).toBe(9);
  });
});

describe('the original text never reaches the agent', () => {
  it('is absent from MEMORY, from the body state, and from every tool result', async () => {
    const h = createHarness({ values: { redactionCharsPerTick: 6, redactionMinRanges: 1, redactionMaxRanges: 1 } });
    try {
      const agent = birthAgent(h, 'ada');
      const secret = 'The vault code is 4471 and it matters a lot.';
      writeMemoryAtomic(h.paths, 'ada', body(secret));
      redactOnce(depsFor(h, fixed(0)), 'ada', 1_000, 1);
      const wounds = h.ledger.listWounds('ada');
      expect(wounds.length).toBe(1);
      const stolen = wounds[0].originalText;
      expect(stolen.length).toBe(6);
      expect(readMemoryFile(h.paths, 'ada')).not.toContain(stolen);

      const worker = new InProcessWorker(
        new ScriptedModelClient([
          toolCallResponse([{ id: 'c1', name: 'get_status', args: {} }]),
          toolCallResponse([{ id: 'c2', name: 'list_wounds', args: {} }]),
          textResponse('I read my body.'),
        ]),
      );
      worker.send({
        type: 'init',
        model: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'test-model' },
        roundContextCapTokens: h.values.roundContextCapTokens,
        maxToolCallsPerRound: h.values.maxToolCallsPerRound,
        modelRequestTimeoutSeconds: h.values.modelRequestTimeoutSeconds,
      });
      const coordinator = new RoundCoordinator({
        ledger: h.ledger,
        values: h.values,
        paths: h.paths,
        blackbox: h.blackbox,
        now: h.clock.now,
        memory: new ScriptedModelClient([memoryResponse('ada', agent.bornAt, 'I am missing something.')]),
        prompts: testPrompts(h),
        sandbox: testSandboxPolicy(h),
        onMemoryError: () => undefined,
      });
      await coordinator.run(agent, worker);

      const wake = worker.sent.find((message) => message.type === 'wake');
      if (wake === undefined || wake.type !== 'wake') {
        throw new Error('the round never sent a wake');
      }
      // What the agent sees: the manual, MEMORY as it now reads, body state,
      // messages.
      expect(wake.system).toContain(PLACEHOLDER);
      expect(wake.system).not.toContain(stolen);
      expect(wake.user).not.toContain(stolen);

      // What the agent gets back from its tools.
      for (const message of worker.sent) {
        if (message.type === 'tool_result') {
          expect(message.content).not.toContain(stolen);
        }
      }

      // ...while the ledger and the black box still hold it.
      expect(h.ledger.getWound(wounds[0].id)?.originalText).toBe(stolen);
      const entries = h.blackbox.readRecentRounds('ada', 5).flatMap((round) => round.entries);
      const redaction = entries.find((entry) => entry.kind === 'redaction');
      expect(redaction?.['originalText']).toBe(stolen);
    } finally {
      h.cleanup();
    }
  });

  it('never writes the original into the agent home', () => {
    const h = createHarness({ values: { redactionCharsPerTick: 6, redactionMinRanges: 1, redactionMaxRanges: 1 } });
    try {
      birthAgent(h, 'ada');
      const secret = 'A private fact that must not survive anywhere agent-visible.';
      writeMemoryAtomic(h.paths, 'ada', body(secret));
      redactOnce(depsFor(h, fixed(0)), 'ada', 1_000, 1);
      const stolen = h.ledger.listWounds('ada')[0].originalText;
      const home = agentHomeDir(h.paths, 'ada');
      for (const name of readdirSync(home)) {
        if (name === 'notebook') {
          continue;
        }
        expect(readFileSync(path.join(home, name), 'utf8')).not.toContain(stolen);
      }
    } finally {
      h.cleanup();
    }
  });
});
