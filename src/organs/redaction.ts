import type { ConservatoryValues } from '../config';
import type { Blackbox } from './blackbox';
import type { FrozenSentenceRecord, Ledger, SatietyAnchor, WoundRecord } from './ledger';

/**
 * Redaction is the body's pain: a starving agent loses characters out of
 * MEMORY, and the only place their text survives is the ledger and the black
 * box. This module holds the rules: how a sentence renders from its ledger
 * row, where the next wound lands, how many redactions the wall clock owes,
 * and how a frozen sentence is put back after a memory rewrite.
 *
 * No function here lets the original text of a wound reach anything the agent
 * can read: the caller writes MEMORY from `renderSentence`, and the black box
 * and the ledger keep the rest.
 */

/** The one character a lost character becomes. */
export const PLACEHOLDER = '\u25AE';

/** A frozen sentence at the moment a memory rewrite needs it. */
export interface FrozenRef {
  id: number;
  /** The sentence exactly as the old MEMORY showed it, scars and all. */
  visible: string;
}

/** A frozen sentence plus what the ledger says is inside it. */
export interface ActiveFrozen {
  record: FrozenSentenceRecord;
  visible: string;
  wounds: WoundRecord[];
}

export interface Range {
  start: number;
  end: number;
}

interface RenderedSentence {
  text: string;
  /**
   * For every character of `text`, the character of `original` it stands for,
   * or null when the character is decoration masking a lost one.
   */
  map: (number | null)[];
}

function renderWithMap(original: string, wounds: readonly WoundRecord[]): RenderedSentence {
  const ordered = [...wounds].sort((left, right) => left.offset - right.offset);
  let text = '';
  const map: (number | null)[] = [];
  let cursor = 0;

  const push = (piece: string, originalIndex: number | null): void => {
    text += piece;
    for (let step = 0; step < piece.length; step += 1) {
      map.push(originalIndex === null ? null : originalIndex + step);
    }
  };

  for (const wound of ordered) {
    const start = Math.max(cursor, wound.offset);
    const end = Math.min(original.length, wound.offset + wound.length);
    if (end <= start) {
      continue;
    }
    push(original.slice(cursor, start), cursor);
    const body = original.slice(start, end);
    if (wound.status === 'untreated') {
      push(PLACEHOLDER.repeat(body.length), null);
    } else if (wound.status === 'scarred') {
      push(PLACEHOLDER, null);
      for (let step = 0; step < body.length; step += 1) {
        push('(', null);
        push(body[step], start + step);
        push(')', null);
        push(PLACEHOLDER, null);
      }
    } else {
      push(body, start);
    }
    cursor = end;
  }
  push(original.slice(cursor), cursor);
  return { text, map };
}

/**
 * The visible text of one sentence: `original` with every wound applied, from
 * the last wound backwards so earlier offsets stay valid. Untreated characters
 * are gone, a scar frames the restored character, and a healed wound leaves no
 * trace at all.
 */
export function renderSentence(original: string, wounds: readonly WoundRecord[]): string {
  return renderWithMap(original, wounds).text;
}

/** One unit a wound may fall in: a sentence, frozen or not. */
export interface SentenceUnit {
  start: number;
  end: number;
  text: string;
  /** Set when this unit is an active frozen sentence. */
  frozen: FrozenSentenceRecord | null;
}

const LINE_PREFIX = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/;

/** Every line's content range; the line break itself is in no range. */
function lineRanges(text: string): Range[] {
  const lines: Range[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lines.push({ start, end: text[index - 1] === '\r' ? index - 1 : index });
      start = index + 1;
    }
  }
  lines.push({ start, end: text.length });
  return lines;
}

/** The index just past the second line: where redaction may begin. */
function headerEnd(text: string): number {
  const lines = lineRanges(text);
  if (lines.length <= 2) {
    return text.length;
  }
  return lines[1].end;
}

function subtractRanges(span: Range, removed: readonly Range[]): Range[] {
  let pieces: Range[] = [span];
  for (const cut of removed) {
    const next: Range[] = [];
    for (const piece of pieces) {
      if (cut.end <= piece.start || cut.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (cut.start > piece.start) {
        next.push({ start: piece.start, end: cut.start });
      }
      if (cut.end < piece.end) {
        next.push({ start: cut.end, end: piece.end });
      }
    }
    pieces = next;
  }
  return pieces.filter((piece) => piece.end > piece.start);
}

function trimRange(text: string, span: Range): Range | null {
  let start = span.start;
  let end = span.end;
  while (start < end && /\s/.test(text[start])) {
    start += 1;
  }
  while (end > start && /\s/.test(text[end - 1])) {
    end -= 1;
  }
  return end > start ? { start, end } : null;
}

/** One line's content, cut after each `[.!?]` that is followed by whitespace. */
function splitSentences(text: string, span: Range): Range[] {
  const out: Range[] = [];
  let start = span.start;
  let index = span.start;
  while (index < span.end) {
    const character = text[index];
    const terminator = character === '.' || character === '!' || character === '?';
    if (terminator && index + 1 < span.end && /\s/.test(text[index + 1])) {
      out.push({ start, end: index + 1 });
      index += 1;
      while (index < span.end && /\s/.test(text[index])) {
        index += 1;
      }
      start = index;
      continue;
    }
    index += 1;
  }
  if (start < span.end) {
    out.push({ start, end: span.end });
  }
  return out.filter((unit) => text.slice(unit.start, unit.end).trim() !== '');
}

/**
 * The sentence units of a text. The first two lines never take part, each
 * active frozen sentence is a unit of its own, and everything else is split by
 * line with its Markdown prefix and surrounding whitespace removed, then by
 * sentence. The frozen ranges are given in the text's own coordinates.
 */
export function sentenceUnits(text: string, frozen: readonly Range[]): SentenceUnit[] {
  const boundary = headerEnd(text);
  const units: SentenceUnit[] = [];
  const taken: Range[] = [];
  for (const span of frozen) {
    if (span.start < boundary) {
      continue;
    }
    units.push({ start: span.start, end: span.end, text: text.slice(span.start, span.end), frozen: null });
    taken.push(span);
  }
  for (const line of lineRanges(text)) {
    for (const piece of subtractRanges(line, taken)) {
      if (piece.end <= boundary) {
        continue;
      }
      const clip = { start: Math.max(piece.start, boundary), end: piece.end };
      const raw = text.slice(clip.start, clip.end);
      const prefix = LINE_PREFIX.exec(raw);
      const withoutPrefix: Range = {
        start: clip.start + (prefix === null ? 0 : prefix[0].length),
        end: clip.end,
      };
      if (withoutPrefix.end <= withoutPrefix.start) {
        continue;
      }
      const content = trimRange(text, withoutPrefix);
      if (content === null) {
        continue;
      }
      for (const sentence of splitSentences(text, content)) {
        units.push({
          start: sentence.start,
          end: sentence.end,
          text: text.slice(sentence.start, sentence.end),
          frozen: null,
        });
      }
    }
  }
  units.sort((left, right) => left.start - right.start);
  return units;
}

/**
 * The instant the agent's satiety ran out: the anchor's own instant when it is
 * already at zero, otherwise the instant the anchored value would reach zero.
 * null means the agent is not starving at all.
 */
export function starvationSinceOf(anchor: SatietyAnchor, decayPerSecond: number): number | null {
  if (anchor.value <= 0) {
    return anchor.asOf;
  }
  if (!(decayPerSecond > 0)) {
    return null;
  }
  return Math.floor(anchor.asOf + (anchor.value / decayPerSecond) * 1000);
}

/**
 * How many redactions the wall clock says the agent owes since it ran out of
 * satiety. A meal or a pause moves the anchor, which starts a new hunger
 * episode, so the paused span is never charged and the old count stops
 * matching anything.
 */
export function dueTicks(now: number, starvationSince: number, intervalSeconds: number): number {
  if (now < starvationSince) {
    return 0;
  }
  const intervalMs = intervalSeconds * 1000;
  if (!(intervalMs > 0)) {
    return 0;
  }
  return Math.floor((now - starvationSince) / intervalMs);
}

function randomInt(random: () => number, min: number, max: number): number {
  if (max <= min) {
    return min;
  }
  const raw = Math.floor(random() * (max - min + 1));
  return min + Math.min(max - min, Math.max(0, raw));
}

/** Splits one tick's characters into `parts` positive pieces. */
function splitAmount(random: () => number, total: number, parts: number): number[] {
  const out: number[] = [];
  let rest = total;
  for (let index = 0; index < parts; index += 1) {
    const left = parts - index;
    if (left === 1) {
      out.push(rest);
      break;
    }
    const take = randomInt(random, 1, rest - (left - 1));
    out.push(take);
    rest -= take;
  }
  return out;
}

interface UnitPlan {
  unit: SentenceUnit;
  /** Maps each visible character to its index in the frozen original. */
  map: (number | null)[] | null;
  /** Original ranges already wounded, so already unavailable. */
  wounded: Range[];
}

function planFor(unit: SentenceUnit, frozen: FrozenSentenceRecord | null, wounds: readonly WoundRecord[]): UnitPlan {
  if (frozen === null) {
    return { unit, map: null, wounded: [] };
  }
  return {
    unit,
    map: renderWithMap(frozen.original, wounds).map,
    wounded: wounds.map((wound) => ({ start: wound.offset, end: wound.offset + wound.length })),
  };
}

function inside(range: Range, index: number): boolean {
  return index >= range.start && index < range.end;
}

/**
 * The woundable runs of a unit, in offsets relative to the unit's visible text:
 * characters inside a frozen original, not already inside a wound, contiguous
 * in the original as well, and not inside a run this tick already chose.
 */
function selectableRuns(plan: UnitPlan, selected: readonly Range[]): Range[] {
  const { unit, map, wounded } = plan;
  const runs: Range[] = [];
  let start: number | null = null;
  let previous = -1;
  for (let index = 0; index < unit.text.length; index += 1) {
    const character = unit.text[index];
    let usable = character !== '\n' && character !== '\r';
    if (usable && map !== null) {
      const original = map[index];
      usable = original !== null && !wounded.some((range) => inside(range, original));
      if (usable && start !== null && original !== previous + 1) {
        runs.push({ start, end: index });
        start = null;
      }
      if (usable) {
        previous = original as number;
      }
    }
    if (usable && selected.some((range) => inside(range, index))) {
      usable = false;
    }
    if (usable) {
      if (start === null) {
        start = index;
      }
    } else if (start !== null) {
      runs.push({ start, end: index });
      start = null;
    }
  }
  if (start !== null) {
    runs.push({ start, end: unit.text.length });
  }
  return runs;
}

export interface PlannedWound {
  unit: SentenceUnit;
  /** Where the wound begins in the unit's visible text. */
  visibleStart: number;
  length: number;
  /** Where the wound begins in the frozen original's coordinates. */
  originalOffset: number;
  originalText: string;
}

/**
 * Chooses this tick's wounds. Between the configured minimum and maximum
 * ranges are placed, the tick's characters are split between them, and each
 * range is a contiguous run no earlier wound touched. No two overlap and no
 * range crosses a sentence.
 */
export function planRedaction(
  text: string,
  active: readonly ActiveFrozen[],
  values: ConservatoryValues,
  random: () => number,
): PlannedWound[] {
  const located: Range[] = [];
  const woundsBySentence = new Map<number, WoundRecord[]>();
  let cursor = 0;
  for (const item of active) {
    let at = text.indexOf(item.visible, cursor);
    if (at < 0) {
      at = text.indexOf(item.visible);
    }
    if (at < 0) {
      continue;
    }
    located.push({ start: at, end: at + item.visible.length });
    woundsBySentence.set(item.record.id, item.wounds);
    cursor = at + item.visible.length;
  }

  const units = sentenceUnits(text, located);
  const frozenRanges = new Map<string, ActiveFrozen>();
  for (const item of active) {
    const at = text.indexOf(item.visible);
    if (at >= 0) {
      frozenRanges.set(`${at}:${at + item.visible.length}`, item);
    }
  }
  const prepared: UnitPlan[] = units.map((unit) => {
    const item = frozenRanges.get(`${unit.start}:${unit.end}`);
    if (item === undefined) {
      return { unit, map: null, wounded: [] };
    }
    unit.frozen = item.record;
    return planFor(unit, item.record, woundsBySentence.get(item.record.id) ?? []);
  });

  const chosen = new Map<number, Range[]>();
  const planned: PlannedWound[] = [];
  const parts = randomInt(random, values.redactionMinRanges, values.redactionMaxRanges);
  const amounts = splitAmount(random, values.redactionCharsPerTick, parts);

  for (const amount of amounts) {
    if (amount <= 0) {
      continue;
    }
    const eligible: number[] = [];
    for (let index = 0; index < prepared.length; index += 1) {
      if (selectableRuns(prepared[index], chosen.get(index) ?? []).length > 0) {
        eligible.push(index);
      }
    }
    if (eligible.length === 0) {
      break;
    }
    const pick = eligible[randomInt(random, 0, eligible.length - 1)];
    const plan = prepared[pick];
    const runs = selectableRuns(plan, chosen.get(pick) ?? []);
    const longEnough = runs.filter((run) => run.end - run.start >= amount);
    let range: Range;
    if (longEnough.length > 0) {
      const run = longEnough[randomInt(random, 0, longEnough.length - 1)];
      const start = run.start + randomInt(random, 0, run.end - run.start - amount);
      range = { start, end: start + amount };
    } else {
      const longest = runs.reduce((best, run) => (run.end - run.start > best.end - best.start ? run : best));
      range = { start: longest.start, end: longest.end };
    }
    const taken = chosen.get(pick) ?? [];
    taken.push(range);
    chosen.set(pick, taken);

    const unit = plan.unit;
    const length = range.end - range.start;
    const originalOffset = plan.map === null ? range.start : (plan.map[range.start] as number);
    const original = unit.frozen === null ? unit.text : unit.frozen.original;
    planned.push({
      unit,
      visibleStart: unit.start + range.start,
      length,
      originalOffset,
      originalText: original.slice(originalOffset, originalOffset + length),
    });
  }
  return planned;
}

/** The active frozen sentences whose visible text really is in this MEMORY. */
export function activeFrozenFor(ledger: Ledger, agent: string, text: string): ActiveFrozen[] {
  const wounds = ledger.listWounds(agent);
  const out: ActiveFrozen[] = [];
  for (const record of ledger.listActiveFrozenSentences(agent)) {
    const mine = wounds.filter((wound) => wound.sentenceId === record.id);
    const visible = renderSentence(record.original, mine);
    if (!text.includes(visible)) {
      continue;
    }
    out.push({ record, visible, wounds: mine });
  }
  return out;
}

/** The same list ordered by where each sentence sits in the text. */
export function frozenRefsFor(ledger: Ledger, agent: string, text: string): FrozenRef[] {
  return activeFrozenFor(ledger, agent, text)
    .map((item) => ({ id: item.record.id, visible: item.visible, at: text.indexOf(item.visible) }))
    .sort((left, right) => left.at - right.at)
    .map((item) => ({ id: item.id, visible: item.visible }));
}

/**
 * Every active frozen sentence the ledger knows, whether or not the text still
 * shows it. A caller that has to correct a rewritten sentence needs this one:
 * the whole point is that the model may have replaced the visible text.
 */
export function ledgerFrozenRefs(ledger: Ledger, agent: string): FrozenRef[] {
  const wounds = ledger.listWounds(agent);
  return ledger.listActiveFrozenSentences(agent).map((record) => ({
    id: record.id,
    visible: renderSentence(
      record.original,
      wounds.filter((wound) => wound.sentenceId === record.id),
    ),
  }));
}

export interface RedactionTickResult {
  status: 'applied' | 'nothing_left';
  wounds: WoundRecord[];
}

export interface RedactionDeps {
  ledger: Ledger;
  values: ConservatoryValues;
  blackbox: Blackbox;
  now(): number;
  readMemory(agent: string): string;
  writeMemory(agent: string, text: string): void;
  random(): number;
}

/**
 * One redaction tick: choose, record in one transaction, then rewrite MEMORY
 * from the ledger. The characters the agent loses live in the ledger and the
 * black box from the moment they are taken, so the visible text can always be
 * recomputed and a rewritten sentence can always be corrected.
 */
export function redactOnce(
  deps: RedactionDeps,
  agent: string,
  starvationSince: number,
  tickIndex: number,
): RedactionTickResult {
  const at = deps.now();
  const text = deps.readMemory(agent);
  const active = activeFrozenFor(deps.ledger, agent, text);
  const planned = planRedaction(text, active, deps.values, deps.random);
  if (planned.length === 0) {
    deps.blackbox.append(agent, 'redaction_skipped', at, null, {
      reason: 'nothing_left',
      starvationSince,
      tickIndex,
    });
    return { status: 'nothing_left', wounds: [] };
  }

  const byUnit = new Map<number, PlannedWound[]>();
  for (const wound of planned) {
    const bucket = byUnit.get(wound.unit.start);
    if (bucket === undefined) {
      byUnit.set(wound.unit.start, [wound]);
    } else {
      bucket.push(wound);
    }
  }

  const created: WoundRecord[] = [];
  const rewrites: { start: number; end: number; text: string }[] = [];
  deps.ledger.transaction(() => {
    for (const group of byUnit.values()) {
      const unit = group[0].unit;
      const original = unit.frozen === null ? unit.text : unit.frozen.original;
      const sentenceId =
        unit.frozen === null ? deps.ledger.insertFrozenSentence(agent, original, at) : unit.frozen.id;
      const woundsOfSentence =
        unit.frozen === null
          ? []
          : deps.ledger.listWounds(agent).filter((wound) => wound.sentenceId === sentenceId);
      for (const item of group) {
        const id = deps.ledger.insertWound({
          agent,
          sentenceId,
          offset: item.originalOffset,
          length: item.length,
          originalText: item.originalText,
          starvationSince,
          tickIndex,
          createdAt: at,
        });
        deps.blackbox.append(agent, 'redaction', at, null, {
          woundId: id,
          sentenceId,
          originalText: item.originalText,
          sentenceOriginal: original,
          starvationSince,
          tickIndex,
        });
        const wound = deps.ledger.getWound(id);
        if (wound !== null) {
          created.push(wound);
          woundsOfSentence.push(wound);
        }
      }
      rewrites.push({
        start: unit.start,
        end: unit.end,
        text: renderSentence(original, woundsOfSentence),
      });
    }
  });

  let updated = text;
  for (const rewrite of [...rewrites].sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, rewrite.start) + rewrite.text + updated.slice(rewrite.end);
  }
  deps.writeMemory(agent, updated);
  return { status: 'applied', wounds: created };
}

export interface RedactionRunResult {
  applied: number;
  skipped: number;
  owed: number;
  wounds: WoundRecord[];
}

/**
 * Every redaction the wall clock owes this agent, oldest first. The count comes
 * from the anchor rather than a timer, so a supervisor that was off catches up
 * and a pause or a meal simply starts a new episode.
 */
export function redactAgent(deps: RedactionDeps, agent: string): RedactionRunResult {
  const anchor = deps.ledger.getSatietyAnchor(agent);
  if (anchor === null) {
    return { applied: 0, skipped: 0, owed: 0, wounds: [] };
  }
  const starvationSince = starvationSinceOf(anchor, deps.values.satietyDecayPerSecond);
  if (starvationSince === null) {
    return { applied: 0, skipped: 0, owed: 0, wounds: [] };
  }
  const already = deps.ledger.countAppliedTicks(agent, starvationSince);
  const owed = dueTicks(deps.now(), starvationSince, deps.values.redactionIntervalSeconds) - already;
  if (owed <= 0) {
    return { applied: 0, skipped: 0, owed: 0, wounds: [] };
  }

  const wounds: WoundRecord[] = [];
  let applied = 0;
  let skipped = 0;
  for (let index = 0; index < owed; index += 1) {
    const result = redactOnce(deps, agent, starvationSince, already + index + 1);
    if (result.status === 'nothing_left') {
      skipped += 1;
      break;
    }
    applied += 1;
    wounds.push(...result.wounds);
  }
  return { applied, skipped, owed, wounds };
}

export interface RestoreResult {
  text: string;
  replaced: number[];
  inserted: number[];
  strayRemoved: number;
  duplicatesRemoved: number;
}

interface PlacedFrozen {
  ref: FrozenRef;
  at: number;
}

function locateAll(text: string, refs: readonly FrozenRef[]): PlacedFrozen[] {
  const out: PlacedFrozen[] = [];
  let cursor = 0;
  for (const ref of refs) {
    let at = text.indexOf(ref.visible, cursor);
    if (at < 0) {
      at = text.indexOf(ref.visible);
    }
    if (at < 0) {
      continue;
    }
    out.push({ ref, at });
    cursor = at + ref.visible.length;
  }
  return out;
}

function lineEndAt(text: string, index: number): number {
  const next = text.indexOf('\n', index);
  return next < 0 ? text.length : next;
}

/** The index just past the second line, or the end of a shorter text. */
function afterSecondLine(text: string): number {
  const lines = lineRanges(text);
  return lines.length <= 2 ? text.length : lines[1].end;
}

function bigrams(text: string): string[] {
  const out: string[] = [];
  for (let index = 0; index + 1 < text.length; index += 1) {
    out.push(text.slice(index, index + 2));
  }
  return out;
}

/** Dice coefficient over character bigrams, with the placeholders removed. */
export function similarity(left: string, right: string): number {
  const a = left.split(PLACEHOLDER).join('');
  const b = right.split(PLACEHOLDER).join('');
  if (a === b) {
    return 1;
  }
  const first = bigrams(a);
  const second = bigrams(b);
  if (first.length === 0 || second.length === 0) {
    return 0;
  }
  const remaining = [...second];
  let shared = 0;
  for (const gram of first) {
    const at = remaining.indexOf(gram);
    if (at >= 0) {
      shared += 1;
      remaining.splice(at, 1);
    }
  }
  return (2 * shared) / (first.length + second.length);
}

function removeStrayPlaceholders(text: string, ranges: readonly Range[]): { text: string; removed: number } {
  let out = '';
  let removed = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === PLACEHOLDER && !ranges.some((range) => inside(range, index))) {
      removed += 1;
      continue;
    }
    out += character;
  }
  return { text: out, removed };
}

function closestSentence(text: string, visible: string, excluded: readonly Range[]): Range | null {
  const units = sentenceUnits(text, excluded).filter(
    (unit) => !excluded.some((range) => range.start === unit.start && range.end === unit.end),
  );
  let best: Range | null = null;
  let bestScore = 0.5;
  for (const unit of units) {
    const score = similarity(unit.text, visible);
    if (score >= bestScore) {
      bestScore = score;
      best = { start: unit.start, end: unit.end };
    }
  }
  return best;
}

/**
 * Puts every frozen sentence back into a rewritten MEMORY. A sentence the model
 * kept is kept and its duplicates dropped; one it filled in is found by
 * similarity and swapped back; one it deleted is inserted after its neighbour
 * in the old order; and a placeholder the model invented is removed. The model
 * is never asked to preserve anything: the ledger is what makes this hold.
 */
export function restoreFrozenSentences(text: string, frozen: readonly FrozenRef[]): RestoreResult {
  const replaced: number[] = [];
  const inserted: number[] = [];
  let duplicatesRemoved = 0;
  let current = text;
  const kept: FrozenRef[] = [];

  for (const ref of frozen) {
    const existing = current.indexOf(ref.visible);
    if (existing >= 0) {
      const rest = current.slice(existing + ref.visible.length);
      const pieces = rest.split(ref.visible);
      if (pieces.length > 1) {
        duplicatesRemoved += pieces.length - 1;
        current = current.slice(0, existing + ref.visible.length) + pieces.join('');
      }
      kept.push(ref);
      continue;
    }

    const placed = locateAll(current, kept);
    const excluded: Range[] = placed.map((item) => ({
      start: item.at,
      end: item.at + item.ref.visible.length,
    }));
    const closest = closestSentence(current, ref.visible, excluded);
    if (closest !== null) {
      current = current.slice(0, closest.start) + ref.visible + current.slice(closest.end);
      replaced.push(ref.id);
      kept.push(ref);
      continue;
    }

    const anchor = placed.length > 0 ? lineEndAt(current, placed[placed.length - 1].at) : afterSecondLine(current);
    current = `${current.slice(0, anchor)}\n${ref.visible}${current.slice(anchor)}`;
    inserted.push(ref.id);
    kept.push(ref);
  }

  const ranges: Range[] = locateAll(current, kept).map((item) => ({
    start: item.at,
    end: item.at + item.ref.visible.length,
  }));
  const stripped = removeStrayPlaceholders(current, ranges);
  return {
    text: stripped.text,
    replaced,
    inserted,
    strayRemoved: stripped.removed,
    duplicatesRemoved,
  };
}
