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
import { treat } from '../src/organs/clinic';
import {
  activeFrozenFor,
  dueTicks,
  frozenRefsFor,
  isHighSurrogate,
  isLowSurrogate,
  PLACEHOLDER,
  planRedaction,
  redactAgent,
  redactOnce,
  renderSentence,
  renderSentenceWithSpans,
  resolveFrozenLocations,
  restoreFrozenSentences,
  sentenceUnits,
  similarity,
  starvationSinceOf,
  type ActiveFrozen,
  type Range,
  type RedactionDeps,
} from '../src/organs/redaction';

/** True when a string holds a surrogate code unit with no partner beside it. */
function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code)) {
      if (index + 1 >= text.length || !isLowSurrogate(text.charCodeAt(index + 1))) {
        return true;
      }
      index += 1;
      continue;
    }
    if (isLowSurrogate(code)) {
      return true;
    }
  }
  return false;
}

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
  return { id, agent: 'ada', original, createdAt: 0, releasedAt: null, startOffset: null };
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

/**
 * The coordinates the console needs to click the right wound.
 *
 * `woundAt` derives the id from the offset, which is fine for the rendering
 * tests above but cannot express the case that matters here: two neighbouring
 * wounds whose ids run opposite to their offsets, because the later one was
 * made first.
 */
function woundWithId(id: number, offset: number, length: number, status: WoundRecord['status']): WoundRecord {
  return {
    id,
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

describe('the span each wound occupies in the rendered sentence (#11)', () => {
  const ORIGINAL = 'abcdefghijklmnopqrst';
  /** Wound #2 sits *before* wound #1, and was created first. */
  const reversed = (first: WoundRecord['status'], second: WoundRecord['status']): WoundRecord[] => [
    woundWithId(1, 10, 4, first),
    woundWithId(2, 6, 4, second),
  ];
  const spanOf = (spans: { woundId: number; start: number; end: number }[], id: number): { start: number; end: number } => {
    const found = spans.find((span) => span.woundId === id);
    if (found === undefined) {
      throw new Error(`no span for wound #${id}`);
    }
    return { start: found.start, end: found.end };
  };

  it('splits two adjacent untreated wounds instead of merging them into one run', () => {
    const rendered = renderSentenceWithSpans(ORIGINAL, reversed('untreated', 'untreated'));
    // Eight placeholders in a row: indistinguishable by their own text, which
    // is exactly why the renderer has to say where each one is.
    expect(rendered.text).toBe(`abcdef${PLACEHOLDER.repeat(8)}opqrst`);
    expect(spanOf(rendered.spans, 2)).toEqual({ start: 6, end: 10 });
    expect(spanOf(rendered.spans, 1)).toEqual({ start: 10, end: 14 });
  });

  it('keeps the spans in text order even though the ids run the other way', () => {
    const rendered = renderSentenceWithSpans(ORIGINAL, reversed('untreated', 'untreated'));
    // Sorted by offset, not by id: the caller that walks the text needs them
    // in the order the text has them.
    expect(rendered.spans.map((span) => span.woundId)).toEqual([2, 1]);
  });

  it('never lets two neighbouring spans overlap or leave a gap between them', () => {
    const rendered = renderSentenceWithSpans(ORIGINAL, reversed('untreated', 'untreated'));
    const first = spanOf(rendered.spans, 2);
    const second = spanOf(rendered.spans, 1);
    expect(first.end).toBe(second.start);
    expect(first.start).toBeLessThan(first.end);
    expect(second.start).toBeLessThan(second.end);
  });

  it('measures the scarred rendering, which is longer than the text it hides', () => {
    const rendered = renderSentenceWithSpans(ORIGINAL, reversed('untreated', 'scarred'));
    // A scar is one placeholder, then "(char)placeholder" per surviving
    // character — so its span is far wider than the four characters taken.
    expect(spanOf(rendered.spans, 2)).toEqual({ start: 6, end: 23 });
    expect(spanOf(rendered.spans, 1)).toEqual({ start: 23, end: 27 });
    expect(rendered.text.slice(6, 23)).toBe(
      `${PLACEHOLDER}(g)${PLACEHOLDER}(h)${PLACEHOLDER}(i)${PLACEHOLDER}(j)${PLACEHOLDER}`,
    );
    expect(rendered.text.slice(23, 27)).toBe(PLACEHOLDER.repeat(4));
  });

  it('still reports a span when both neighbours are scarred', () => {
    const rendered = renderSentenceWithSpans(ORIGINAL, reversed('scarred', 'scarred'));
    expect(spanOf(rendered.spans, 2)).toEqual({ start: 6, end: 23 });
    expect(spanOf(rendered.spans, 1)).toEqual({ start: 23, end: 40 });
    expect(rendered.text.slice(23, 40)).toBe(
      `${PLACEHOLDER}(k)${PLACEHOLDER}(l)${PLACEHOLDER}(m)${PLACEHOLDER}(n)${PLACEHOLDER}`,
    );
  });

  it('reports a healed wound over the text it gave back, not over a bar', () => {
    const rendered = renderSentenceWithSpans(ORIGINAL, [woundWithId(1, 10, 4, 'healed')]);
    // A healed wound leaves the original characters in place, so its span
    // covers exactly those. The console skips healed wounds when it places
    // clickable bars, so this is bookkeeping rather than something it draws.
    expect(spanOf(rendered.spans, 1)).toEqual({ start: 10, end: 14 });
    expect(rendered.text.slice(10, 14)).toBe('klmn');
    expect(rendered.text).toBe(ORIGINAL);
  });

  it('agrees with renderSentence on the text, span bookkeeping aside', () => {
    const wounds = reversed('untreated', 'scarred');
    expect(renderSentenceWithSpans(ORIGINAL, wounds).text).toBe(renderSentence(ORIGINAL, wounds));
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
  /**
   * The pace the body is configured for, measured at the wall clock. One
   * interval of starvation takes exactly one interval's budget, whatever the
   * number of ranges that interval is split into. Before the fix the counter
   * counted wound rows instead of ticks, so a tick that drew six ranges was
   * billed as six intervals and the next five were skipped.
   */
  const SHIPPED = {
    redactionIntervalSeconds: 60,
    redactionCharsPerTick: 46,
    redactionMinRanges: 2,
    redactionMaxRanges: 6,
  };

  /** A MEMORY long enough that every interval can always take its full budget. */
  function longMemory(): string {
    return body(
      'The long afternoon by the window repeated itself in the same words until the light moved. '.repeat(400),
    );
  }

  function runPace(
    h: Harness,
    random: () => number,
    intervals: number,
  ): { applied: number[]; chars: number[] } {
    birthAgent(h, 'ada');
    writeMemoryAtomic(h.paths, 'ada', longMemory());
    // Satiety 100 at 0.05/s runs out after 2000 seconds: the episode starts there.
    h.clock.advanceSeconds(2000);
    const deps = depsFor(h, random);
    const applied: number[] = [];
    const chars: number[] = [];
    for (let step = 0; step < intervals; step += 1) {
      h.clock.advanceSeconds(SHIPPED.redactionIntervalSeconds);
      applied.push(redactAgent(deps, 'ada').applied);
      chars.push(h.ledger.untreatedRedactedChars('ada'));
    }
    return { applied, chars };
  }

  it('takes the full configured budget every interval, whatever ranges it is split into', () => {
    // A real random source: the number of ranges drawn varies run to run, which
    // is the condition that used to make the count drift.
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const h = createHarness({ values: SHIPPED });
    try {
      const { applied, chars } = runPace(h, random, 60);
      // Every interval was represented: none was skipped while text remained.
      expect(applied.every((count) => count === 1)).toBe(true);
      // And the cumulative loss is exactly what the configuration promises.
      expect(chars[chars.length - 1]).toBe(60 * SHIPPED.redactionCharsPerTick);
      // One tick per interval, not one per wound row.
      const anchor = h.ledger.getSatietyAnchor('ada');
      expect(anchor).not.toBeNull();
      const starvationSince = starvationSinceOf(anchor!, h.values.satietyDecayPerSecond);
      expect(h.ledger.countAppliedTicks('ada', starvationSince!)).toBe(60);
      expect(h.ledger.listWounds('ada').length).toBeGreaterThan(60);
    } finally {
      h.cleanup();
    }
  });

  it('keeps the same pace with a single range, the control the old bug could not show', () => {
    const h = createHarness({
      values: { ...SHIPPED, redactionMinRanges: 1, redactionMaxRanges: 1 },
    });
    try {
      const { applied, chars } = runPace(h, fixed(0), 60);
      expect(applied.every((count) => count === 1)).toBe(true);
      expect(chars[chars.length - 1]).toBe(60 * SHIPPED.redactionCharsPerTick);
    } finally {
      h.cleanup();
    }
  });

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

describe('resolving where each frozen sentence sits', () => {
  function item(id: number, visible: string, startOffset: number | null) {
    return { id, visible, startOffset };
  }

  it('takes the recorded offset when the text is still there', () => {
    const text = 'aaa TARGET bbb TARGET';
    const resolved = resolveFrozenLocations(text, [
      item(1, 'TARGET', 4),
      item(2, 'TARGET', 15),
    ]);
    expect(resolved.get(1)).toBe(4);
    expect(resolved.get(2)).toBe(15);
  });

  it('never lets two sentences claim the same characters', () => {
    const text = 'aaa TARGET bbb TARGET';
    // Both recorded offsets point at the first occurrence: one of them has to
    // move to the second rather than both collapsing onto the same place.
    const resolved = resolveFrozenLocations(text, [
      item(1, 'TARGET', 4),
      item(2, 'TARGET', 4),
    ]);
    expect(resolved.get(1)).toBe(4);
    expect(resolved.get(2)).toBe(15);
  });

  it('falls back to the earliest free occurrence when the offset has gone stale', () => {
    const text = 'aaa TARGET bbb TARGET';
    const resolved = resolveFrozenLocations(text, [
      item(1, 'TARGET', 999),
      item(2, 'TARGET', 0),
    ]);
    // Both offsets are wrong, so both search; the earlier ledger id wins the
    // earlier occurrence.
    expect(resolved.get(2)).toBe(4);
    expect(resolved.get(1)).toBe(15);
  });

  it('leaves out a sentence that is nowhere in the text at all', () => {
    const resolved = resolveFrozenLocations('nothing to see', [item(1, 'TARGET', 3)]);
    expect(resolved.has(1)).toBe(false);
  });

  it('lets the longer sentence win the characters a shorter one occurs inside', () => {
    // The four placeholders of the short sentence also occur inside the long
    // one, but nothing of the short sentence's own is in the text.
    const text = 'The vault is ▮▮▮▮.';
    const resolved = resolveFrozenLocations(text, [
      item(1, '▮▮▮▮', null),
      item(2, 'The vault is ▮▮▮▮.', null),
    ]);
    expect(resolved.get(2)).toBe(0);
    expect(resolved.has(1)).toBe(false);
  });

  it('finds the short sentence at its own place when it has one', () => {
    const text = 'The vault is ▮▮▮▮.\n▮▮▮▮';
    const resolved = resolveFrozenLocations(text, [
      item(1, '▮▮▮▮', null),
      item(2, 'The vault is ▮▮▮▮.', null),
    ]);
    // Not the four inside the long sentence: those belong to the long one.
    expect(resolved.get(2)).toBe(0);
    expect(resolved.get(1)).toBe(text.lastIndexOf('▮▮▮▮'));
  });

  it('does not match an empty sentence against anything', () => {
    const resolved = resolveFrozenLocations('some text', [
      item(1, '', null),
      item(2, 'some', null),
    ]);
    expect(resolved.has(1)).toBe(false);
    expect(resolved.get(2)).toBe(0);
  });

  it('is unmoved by an offset that lands between the halves of an astral character', () => {
    const text = 'a🐕TARGET';
    // 2 is the low surrogate of the dog, not the start of `TARGET`.
    const resolved = resolveFrozenLocations(text, [item(1, 'TARGET', 2)]);
    expect(resolved.get(1)).toBe(3);
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

describe('two frozen sentences that read exactly the same (#4)', () => {
  const values = testValues({ redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 });

  /** Two identical sentences, both wounded the same way, at their real places. */
  function twoTwins(h: Harness): { ids: [number, number]; visible: string; text: string } {
    const original = 'I remember the garden.';
    const first = h.ledger.insertFrozenSentence('ada', original, h.clock.now(), 0);
    const second = h.ledger.insertFrozenSentence('ada', original, h.clock.now(), 0);
    for (const sentenceId of [first, second]) {
      h.ledger.insertWound({
        agent: 'ada',
        sentenceId,
        offset: 0,
        length: 4,
        originalText: 'I re',
        starvationSince: 1,
        tickIndex: 1,
        createdAt: h.clock.now(),
      });
    }
    const visible = renderSentence(original, h.ledger.listWounds('ada'));
    // Nothing but the two sentences below the header, so a tick has no other
    // unit to fall back on and every assertion below is about the twins.
    const text = body(visible, visible);
    const firstAt = HEADER.length + 1;
    h.ledger.setFrozenSentenceOffset(first, firstAt);
    h.ledger.setFrozenSentenceOffset(second, firstAt + visible.length + 1);
    writeMemoryAtomic(h.paths, 'ada', text);
    return { ids: [first, second], visible, text };
  }

  it('locates both at their own places instead of collapsing them onto the first', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const { ids, visible, text } = twoTwins(h);

      const active = activeFrozenFor(h.ledger, 'ada', text);
      expect(active.map((item) => item.record.id)).toEqual([ids[0], ids[1]]);
      expect(active[0].visible).toBe(visible);
      expect(active[1].visible).toBe(visible);

      const refs = frozenRefsFor(h.ledger, 'ada', text);
      expect(refs.map((ref) => ref.id)).toEqual([ids[0], ids[1]]);
      expect(refs[0].startOffset).toBe(text.indexOf(visible));
      expect(refs[1].startOffset).toBe(text.indexOf(visible, text.indexOf(visible) + 1));
      // The two offsets are genuinely different: this is the whole bug.
      expect(refs[0].startOffset).not.toBe(refs[1].startOffset);

      const resolved = resolveFrozenLocations(
        text,
        active.map((item) => ({
          id: item.record.id,
          visible: item.visible,
          startOffset: item.record.startOffset,
        })),
      );
      expect(resolved.get(ids[0])).toBe(refs[0].startOffset);
      expect(resolved.get(ids[1])).toBe(refs[1].startOffset);
    } finally {
      h.cleanup();
    }
  });

  it('wounds each twin in its own slot, never both in the first', () => {
    const h = createHarness({ values: { redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 } });
    try {
      birthAgent(h, 'ada');
      const { ids } = twoTwins(h);
      const text = readMemoryFile(h.paths, 'ada');
      const active = activeFrozenFor(h.ledger, 'ada', text);

      const planned = planRedaction(text, active, values, fixed(0));
      expect(planned.length).toBe(1);

      // Whichever twin the tick picked, the wound sits inside that twin's own
      // span, not inside the first twin's.
      const before = active[0].visible.length;
      const planned0 = planned[0];
      const firstStart = text.indexOf(active[0].visible);
      const secondStart = text.indexOf(active[1].visible, firstStart + 1);
      const inFirst = planned0.visibleStart >= firstStart && planned0.visibleStart < firstStart + before;
      const inSecond = planned0.visibleStart >= secondStart && planned0.visibleStart < secondStart + before;
      expect(inFirst !== inSecond).toBe(true);
      expect([...new Set(ids)]).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('restores both after a rewrite, keeping them apart and deleting neither', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const { visible, text } = twoTwins(h);

      const refs = frozenRefsFor(h.ledger, 'ada', text);
      const result = restoreFrozenSentences(text, refs);

      expect(result.text.split(visible).length - 1).toBe(2);
      expect(result.duplicatesRemoved).toBe(0);
      expect(result.inserted).toEqual([]);
      expect(result.text).toBe(text);
    } finally {
      h.cleanup();
    }
  });

  it('survives a real tick: both twins are still in MEMORY afterwards', () => {
    const h = createHarness({ values: { redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 } });
    try {
      birthAgent(h, 'ada');
      twoTwins(h);
      const deps = depsFor(h, fixed(0));

      const first = redactOnce(deps, 'ada', 1_000, 1);
      expect(first.status).toBe('applied');

      const written = readMemoryFile(h.paths, 'ada');
      // Both sentences are still there, each carrying its own wound.
      for (const sentence of h.ledger.listActiveFrozenSentences('ada')) {
        const mine = h.ledger.listWounds('ada').filter((wound) => wound.sentenceId === sentence.id);
        expect(written).toContain(renderSentence(sentence.original, mine));
      }
      const offsets = h.ledger
        .listActiveFrozenSentences('ada')
        .map((sentence) => sentence.startOffset);
      expect(offsets.filter((offset) => offset !== null)).toHaveLength(2);
      expect(new Set(offsets).size).toBe(2);
      // 4 characters for each twin's first wound, plus the 4 this tick took.
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(12);
      const second = h.ledger.listWounds('ada').filter((wound) => wound.tickIndex === 1);
      expect(new Set(second.map((wound) => wound.sentenceId)).size).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});

describe('wounds never split an astral character (#37)', () => {
  const values = testValues({ redactionCharsPerTick: 4, redactionMinRanges: 1, redactionMaxRanges: 1 });

  it('renders a scarred astral character whole, never as two surrogate halves', () => {
    const rendered = renderSentence('a🐕b', [woundAt(1, 2, 'scarred')]);
    expect(rendered).toBe(`a${PLACEHOLDER}(${'🐕'})${PLACEHOLDER}b`);
    expect(hasUnpairedSurrogate(rendered)).toBe(false);
    expect(rendered).not.toContain('\uFFFD');
  });

  it('never splits a surrogate pair, however the tick draws it', () => {
    const text = body('I fed the 🐕 dog and 🐈 cat and left.');
    const values2 = testValues({ redactionCharsPerTick: 1, redactionMinRanges: 1, redactionMaxRanges: 1 });
    for (let seed = 0; seed <= 1; seed += 0.05) {
      for (let chars = 1; chars <= 6; chars += 1) {
        const drawn = planRedaction(text, [], { ...values2, redactionCharsPerTick: chars }, fixed(seed));
        for (const wound of drawn) {
          const start = wound.visibleStart;
          const end = start + wound.length;
          expect(text.slice(start, end)).not.toContain('\uFFFD');
          expect(hasUnpairedSurrogate(text.slice(start, end))).toBe(false);
          // The cut never lands between the two halves of one character.
          if (start > 0 && start < text.length) {
            expect(isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))).toBe(false);
          }
          if (end > 0 && end < text.length) {
            expect(isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))).toBe(false);
          }
        }
      }
    }
  });

  it('keeps an emoji sentence protected through redaction, scarring, and every tick after', () => {
    const h = createHarness({ values: { redactionCharsPerTick: 3, redactionMinRanges: 1, redactionMaxRanges: 1 } });
    try {
      birthAgent(h, 'ada');
      const original = 'I fed the 🐕 dog and 🐈 cat.';
      writeMemoryAtomic(h.paths, 'ada', body(original));
      const deps = depsFor(h, fixed(0));

      for (let tick = 0; tick < 6; tick += 1) {
        const result = redactOnce(deps, 'ada', 1_000, tick + 1);
        const written = readMemoryFile(h.paths, 'ada');
        expect(written).not.toContain('\uFFFD');
        expect(hasUnpairedSurrogate(written)).toBe(false);

        // The sentence the ledger holds is exactly what is on disk, so the next
        // tick still finds it: a lost sentence is one that can never be wounded
        // or healed again.
        const active = activeFrozenFor(h.ledger, 'ada', written);
        expect(active.length).toBe(1);
        for (const item of active) {
          expect(written).toContain(item.visible);
        }
        if (result.wounds.length > 0) {
          expect(result.wounds[0].originalText).not.toContain('\uFFFD');
        }
      }

      // Ordinary treatment scars the emoji sentence, which is the other path
      // that used to wrap each half of a pair on its own.
      const wound = h.ledger.listWounds('ada')[0];
      const outcome = treat(
        { ledger: h.ledger, values: h.values, paths: h.paths, blackbox: h.blackbox, now: h.clock.now },
        'ada',
        wound.id,
        'ordinary',
        'agent',
      );
      expect(outcome.ok).toBe(true);
      const afterTreat = readMemoryFile(h.paths, 'ada');
      expect(afterTreat).not.toContain('\uFFFD');
      expect(hasUnpairedSurrogate(afterTreat)).toBe(false);
      // And it is still found, so its remaining wounds stay protected.
      expect(activeFrozenFor(h.ledger, 'ada', afterTreat).length).toBe(1);
      expect(redactOnce(deps, 'ada', 1_000, 7).status).toBe('applied');
      expect(readMemoryFile(h.paths, 'ada')).not.toContain('\uFFFD');
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

describe('a tick that fails to write MEMORY does not charge twice', () => {
  /** Wounds are committed in a transaction; MEMORY is written after it. */
  it('reconciles the file against the ledger before planning the next tick', () => {
    const h = createHarness({
      values: { redactionCharsPerTick: 20, redactionMinRanges: 1, redactionMaxRanges: 1 },
    });
    try {
      birthAgent(h, 'ada');
      writeMemoryAtomic(h.paths, 'ada', body('Alpha bravo charlie delta echo foxtrot golf hotel india juliet.'));
      h.clock.advanceSeconds(2000);
      h.clock.advanceSeconds(60);

      const failing = { ...depsFor(h, fixed(0)), writeMemory: () => { throw new Error('disk full'); } };
      expect(() => redactAgent(failing, 'ada')).toThrow(/disk full/);

      // The ledger holds the damage the file never showed.
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(20);
      expect(readMemoryFile(h.paths, 'ada')).not.toContain(PLACEHOLDER);

      h.clock.advanceSeconds(60);
      const repaired = redactAgent(depsFor(h, fixed(0)), 'ada');
      expect(repaired.applied).toBe(1);
      // Exactly two intervals of damage, not three: the missed write was not a
      // second physical loss of the same characters.
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(40);
      // And the file now shows what the ledger says, placeholders and all.
      expect((readMemoryFile(h.paths, 'ada').match(new RegExp(PLACEHOLDER, 'g')) ?? []).length).toBe(40);
      // One wound per tick, never two over the same text.
      const wounds = h.ledger.listWounds('ada');
      expect(wounds.length).toBe(2);
      expect(new Set(wounds.map((wound) => wound.tickIndex)).size).toBe(2);
    } finally {
      h.cleanup();
    }
  });
});

describe('a treatment whose rewrite is lost keeps its protection', () => {
  it('does not re-wound or re-charge the region the agent paid for', () => {
    const h = createHarness({
      values: { redactionCharsPerTick: 20, redactionMinRanges: 1, redactionMaxRanges: 1 },
    });
    try {
      birthAgent(h, 'ada');
      writeMemoryAtomic(h.paths, 'ada', body('Alpha bravo charlie delta echo foxtrot golf hotel india juliet.'));
      h.clock.advanceSeconds(2000);
      h.clock.advanceSeconds(60);
      redactAgent(depsFor(h, fixed(0)), 'ada');

      const wound = h.ledger.listWounds('ada')[0];
      expect(wound).toBeDefined();
      const before = readMemoryFile(h.paths, 'ada');
      const treated = treat(
        { ledger: h.ledger, values: h.values, paths: h.paths, blackbox: h.blackbox, now: h.clock.now },
        'ada',
        wound!.id,
        'ordinary',
        'agent',
      );
      expect(treated.ok).toBe(true);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(0);
      const lifetimeAfterTreat = h.ledger.lifetimeRedactedChars('ada');

      // The rewrite never landed: the file still shows the untreated placeholders.
      writeMemoryAtomic(h.paths, 'ada', before);

      // The next tick repairs the file from the ledger before it plans anything,
      // so the paid-for region is not offered to the redactor again.
      h.clock.advanceSeconds(60);
      const next = redactAgent(depsFor(h, fixed(0)), 'ada');
      expect(next.applied).toBe(1);
      expect(h.ledger.untreatedRedactedChars('ada')).toBe(20);
      expect(h.ledger.lifetimeRedactedChars('ada')).toBe(lifetimeAfterTreat + 20);
      // The scar is visible in the file, and nothing shows the old wound.
      const disk = readMemoryFile(h.paths, 'ada');
      expect(disk).toContain('\u25AE(');
      expect(h.ledger.getWound(wound!.id)?.status).toBe('scarred');
    } finally {
      h.cleanup();
    }
  });
});
