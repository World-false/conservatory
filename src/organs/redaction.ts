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

/**
 * A frozen sentence at the moment a memory rewrite needs it.
 *
 * `id` is the identity; `visible` is only how the sentence currently reads.
 * Two frozen sentences may read exactly the same, so anything that has to find
 * one of them must use `id` plus a location, never `visible` alone.
 */
export interface FrozenRef {
  id: number;
  /** The sentence exactly as the old MEMORY showed it, scars and all. */
  visible: string;
  /** Known character offset in MEMORY before the rewrite, if available. */
  startOffset?: number | null;
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
  /** Where each wound's own rendering sits inside `text`. */
  spans: RenderedWoundSpan[];
}

/**
 * The characters one wound occupies in the rendered sentence, by wound id.
 *
 * The console cannot find a wound by searching for its rendered form: two
 * adjacent untreated wounds join into one run of placeholders, so the search
 * would hand the first wound the whole run and leave the second unplaceable.
 * The renderer already knows where each one landed, so it says so.
 */
export interface RenderedWoundSpan {
  woundId: number;
  /** Inclusive index of the wound's first character in the rendered text. */
  start: number;
  /** Exclusive index just past its last character. */
  end: number;
}

/**
 * A character outside the Basic Multilingual Plane — an emoji, most obviously —
 * is two UTF-16 code units: a high surrogate followed by a low one. Slicing or
 * wrapping between them leaves each half alone on disk, and Node writes each
 * half out as U+FFFD, which no longer matches the ledger's rendering. Every
 * range this module produces therefore has to fall on a pair boundary.
 */
export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when cutting at `index` would split an astral character in half. */
function splitsPairAt(text: string, index: number): boolean {
  return index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1));
}

function renderWithMap(original: string, wounds: readonly WoundRecord[]): RenderedSentence {
  const ordered = [...wounds].sort((left, right) => left.offset - right.offset);
  let text = '';
  const map: (number | null)[] = [];
  const spans: RenderedWoundSpan[] = [];
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
    // Recorded before the wound's own text is appended, so the span covers
    // exactly this wound's rendering and nothing of the literal text before it.
    const spanStart = text.length;
    const body = original.slice(start, end);
    if (wound.status === 'untreated') {
      push(PLACEHOLDER.repeat(body.length), null);
    } else if (wound.status === 'scarred') {
      push(PLACEHOLDER, null);
      for (let step = 0; step < body.length; step += 1) {
        push('(', null);
        // An astral character is wrapped whole: two separate wrappers would put
        // each half of the surrogate pair on its own, and each half on its own
        // is not a character at all.
        if (isHighSurrogate(body.charCodeAt(step)) && step + 1 < body.length && isLowSurrogate(body.charCodeAt(step + 1))) {
          push(body.slice(step, step + 2), start + step);
          step += 1;
        } else {
          push(body[step], start + step);
        }
        push(')', null);
        push(PLACEHOLDER, null);
      }
    } else {
      push(body, start);
    }
    spans.push({ woundId: wound.id, start: spanStart, end: text.length });
    cursor = end;
  }
  push(original.slice(cursor), cursor);
  return { text, map, spans };
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

/**
 * The same rendering as `renderSentence`, plus where each wound landed in it.
 *
 * This is the only reliable way to point at a wound inside a rendered
 * sentence. Searching the rendered text for a wound's own characters fails
 * exactly where it matters most: `▯▯▯` and `▯▯▯▯` next to each other are one
 * run of seven placeholders, and the second wound — the one created later, so
 * the higher id — is indistinguishable from the first by its text alone. The
 * caller that has to attribute a click to a specific wound therefore asks the
 * renderer rather than guessing.
 */
export function renderSentenceWithSpans(
  original: string,
  wounds: readonly WoundRecord[],
): { text: string; spans: RenderedWoundSpan[] } {
  const rendered = renderWithMap(original, wounds);
  return { text: rendered.text, spans: rendered.spans };
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
 * in the original as well, and not inside a run this tick already chose. A run
 * never begins on the low half of an astral character or ends after its high
 * half: a wound that splits one would leave two unpaired code units behind, and
 * each of them is written to disk as `U+FFFD`.
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
  const snapped: Range[] = [];
  for (const run of runs) {
    let left = run.start;
    let right = run.end;
    if (splitsPairAt(unit.text, left)) {
      left += 1;
    }
    if (right > left && isHighSurrogate(unit.text.charCodeAt(right - 1))) {
      right -= 1;
    }
    if (right > left) {
      snapped.push({ start: left, end: right });
    }
  }
  return snapped;
}

/**
 * The start of a sub-range of `amount` characters inside `run` that splits no
 * astral character. `preferred` is tried first so the caller's draw still
 * decides where the wound lands whenever the draw is a legal position.
 */
function startInsideRun(text: string, run: Range, amount: number, preferred: number): number | null {
  const span = run.end - run.start - amount;
  if (span < 0) {
    return null;
  }
  const order = [preferred];
  for (let step = preferred + 1; step <= span; step += 1) {
    order.push(step);
  }
  for (let step = preferred - 1; step >= 0; step -= 1) {
    order.push(step);
  }
  for (const offset of order) {
    const start = run.start + offset;
    if (!splitsPairAt(text, start) && !splitsPairAt(text, start + amount)) {
      return start;
    }
  }
  return null;
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
  // Two frozen sentences may read exactly the same, so where each one sits is
  // resolved by id and offset rather than by searching for its text: a search
  // would hand both of them the first occurrence and one of them would be lost.
  const resolved = resolveFrozenLocations(
    text,
    active.map((item) => ({ id: item.record.id, visible: item.visible, startOffset: item.record.startOffset })),
  );
  const located: Range[] = [];
  const frozenRanges = new Map<string, ActiveFrozen>();
  const woundsBySentence = new Map<number, WoundRecord[]>();
  for (const item of active) {
    const at = resolved.get(item.record.id);
    if (at === undefined) {
      continue;
    }
    located.push({ start: at, end: at + item.visible.length });
    frozenRanges.set(`${at}:${at + item.visible.length}`, item);
    woundsBySentence.set(item.record.id, item.wounds);
  }

  const units = sentenceUnits(text, located);
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

  /**
   * Places one contiguous range of at most `amount` characters somewhere with
   * room left, and reports how many characters it actually took.
   *
   * `requireFull` refuses to take a shorter run at all. A tick owes its
   * configured budget, so a shortfall is carried into another range rather than
   * dropped — dropping it was the other half of the slow-damage bug, where a
   * starving agent lost less than the configuration says it should. The one
   * exception is genuinely exhausted text, where the caller has nothing left to
   * spend the shortfall on.
   */
  const place = (amount: number, requireFull: boolean): number => {
    const eligible: number[] = [];
    for (let index = 0; index < prepared.length; index += 1) {
      if (selectableRuns(prepared[index], chosen.get(index) ?? []).length > 0) {
        eligible.push(index);
      }
    }
    if (eligible.length === 0) {
      return 0;
    }
    const pick = eligible[randomInt(random, 0, eligible.length - 1)];
    const plan = prepared[pick];
    const runs = selectableRuns(plan, chosen.get(pick) ?? []);
    const longEnough = runs.filter((run) => run.end - run.start >= amount);
    let range: Range;
    if (longEnough.length > 0) {
      const run = longEnough[randomInt(random, 0, longEnough.length - 1)];
      const drawn = randomInt(random, 0, run.end - run.start - amount);
      // The draw decides where the wound lands, but never across an astral
      // character: the nearest legal position is used instead.
      const start = startInsideRun(plan.unit.text, run, amount, drawn);
      if (start === null) {
        return 0;
      }
      range = { start, end: start + amount };
    } else {
      if (requireFull) {
        return 0;
      }
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
    return length;
  };

  // The configured ranges first, each carrying whatever the one before it could
  // not take. The debt is a character count, not a range count, so a range that
  // landed in a short run hands its remainder to the next one.
  let owed = values.redactionCharsPerTick;
  for (const amount of amounts) {
    if (owed <= 0) {
      break;
    }
    const placed = place(Math.min(amount, owed), false);
    if (placed === 0) {
      break;
    }
    owed -= placed;
  }
  // Whatever this tick still owes, but only somewhere that can take the whole
  // remainder: a nearly exhausted MEMORY must report as exhausted rather than be
  // nibbled into an extra range to make the arithmetic come out.
  if (owed > 0) {
    place(owed, true);
  }
  return planned;
}

/** Just enough of a frozen sentence to find it: its id, its text, its offset. */
export interface FrozenLocationItem {
  id: number;
  visible: string;
  startOffset: number | null;
}

function rangesOverlap(left: Range, right: Range): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * Maps each frozen sentence's id to where it starts in `text`, with the
 * guarantee that no two of them ever claim overlapping ranges.
 *
 * The recorded offset is tried first, because it is the only thing that can
 * tell two sentences reading exactly the same apart; a sentence whose offset no
 * longer holds its text has been moved or rewritten, and falls through to a
 * search for the earliest occurrence nobody else has claimed. A sentence's text
 * alone is never treated as its identity — that is what collapses duplicates.
 *
 * A sentence that is nowhere in `text` is simply absent from the map. Callers
 * decide whether that is "skip it" or "restore it first".
 */
export function resolveFrozenLocations(text: string, items: readonly FrozenLocationItem[]): Map<number, number> {
  const out = new Map<number, number>();
  const claimed: Range[] = [];
  const taken = (range: Range): boolean => claimed.some((other) => rangesOverlap(range, other));
  const claim = (id: number, at: number, length: number): void => {
    out.set(id, at);
    claimed.push({ start: at, end: at + length });
  };

  // Pass 1: the recorded offsets, in ascending order so a rewrite that shifted
  // one sentence cannot steal the slot of the sentence above it.
  const anchored = items
    .filter((item) => item.startOffset !== null && item.startOffset !== undefined)
    .sort((left, right) => (left.startOffset as number) - (right.startOffset as number) || left.id - right.id);
  for (const item of anchored) {
    const at = item.startOffset as number;
    // The recorded offset names the position in code units, so the comparison
    // is exact and byte-for-byte: a recorded offset that lands between the two
    // halves of an astral character simply does not match anything, and the
    // sentence falls through to the search below.
    if (at < 0 || text.slice(at, at + item.visible.length) !== item.visible) {
      continue;
    }
    const range = { start: at, end: at + item.visible.length };
    if (item.visible.length > 0 && taken(range)) {
      continue;
    }
    claim(item.id, at, item.visible.length);
  }

  // Pass 2: everything left, taking the earliest occurrence nobody else holds.
  // The longest text goes first: a short sentence's text can occur inside a
  // longer one's, and only the longer one is really there — a sentence made
  // entirely of placeholders is a substring of any longer run of them.
  const remaining = items
    .filter((item) => !out.has(item.id))
    .sort(
      (left, right) =>
        right.visible.length - left.visible.length ||
        (left.startOffset ?? Number.MAX_SAFE_INTEGER) - (right.startOffset ?? Number.MAX_SAFE_INTEGER) ||
        left.id - right.id,
    );
  for (const item of remaining) {
    if (item.visible.length === 0) {
      continue;
    }
    let at = text.indexOf(item.visible);
    while (at >= 0) {
      const range = { start: at, end: at + item.visible.length };
      if (!taken(range)) {
        claim(item.id, at, item.visible.length);
        break;
      }
      at = text.indexOf(item.visible, at + 1);
    }
  }
  return out;
}

/**
 * The active frozen sentences whose visible text really is in this MEMORY,
 * ordered by where they sit. Each one is located by id, never by searching for
 * its text, so two sentences that read the same keep their own places.
 */
export function activeFrozenFor(ledger: Ledger, agent: string, text: string): ActiveFrozen[] {
  const wounds = ledger.listWounds(agent);
  const candidates: { record: FrozenSentenceRecord; visible: string; wounds: WoundRecord[] }[] = [];
  for (const record of ledger.listActiveFrozenSentences(agent)) {
    const mine = wounds.filter((wound) => wound.sentenceId === record.id);
    candidates.push({ record, visible: renderSentence(record.original, mine), wounds: mine });
  }
  const resolved = resolveFrozenLocations(
    text,
    candidates.map((item) => ({
      id: item.record.id,
      visible: item.visible,
      startOffset: item.record.startOffset,
    })),
  );
  return candidates
    .filter((item) => resolved.has(item.record.id))
    .sort((left, right) => (resolved.get(left.record.id) as number) - (resolved.get(right.record.id) as number));
}

/** The same list ordered by where each sentence sits in the text. */
export function frozenRefsFor(ledger: Ledger, agent: string, text: string): FrozenRef[] {
  return activeFrozenFor(ledger, agent, text).map((item) => ({
    id: item.record.id,
    visible: item.visible,
    startOffset: item.record.startOffset,
  }));
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
    startOffset: record.startOffset,
  }));
}

/**
 * Repairs MEMORY against the ledger before a tick plans anything.
 *
 * The wounds of a tick are committed in one transaction and MEMORY is written
 * after it, so a crash or a full disk in between leaves the ledger holding
 * damage the file never showed. Planning from that stale file would pick the
 * same reachable characters again and charge them twice — the same characters,
 * two wounds, two entries against the death line, for one physical loss.
 *
 * Rendering every active frozen sentence from its ledger row makes the ordering
 * harmless: a tick first rewrites whatever the ledger already says, and only
 * then decides where new damage goes. It is also what repairs a sentence the
 * model has since reworded, and it locates each sentence by id, so two
 * sentences that read the same keep their own places.
 */
export function reconcileMemoryWithLedger(
  ledger: Ledger,
  agent: string,
  text: string,
): { text: string; changed: boolean } {
  const wounds = ledger.listWounds(agent);
  const refs: FrozenRef[] = ledger.listActiveFrozenSentences(agent).map((record) => ({
    id: record.id,
    visible: renderSentence(
      record.original,
      wounds.filter((wound) => wound.sentenceId === record.id),
    ),
    startOffset: record.startOffset,
  }));
  if (refs.length === 0) {
    return { text, changed: false };
  }

  const at = resolveFrozenLocations(
    text,
    refs.map((ref) => ({ id: ref.id, visible: ref.visible, startOffset: ref.startOffset ?? null })),
  );
  const edits: { start: number; end: number; text: string }[] = [];
  const missing: FrozenRef[] = [];
  for (const ref of refs) {
    const found = at.get(ref.id);
    if (found === undefined) {
      missing.push(ref);
      continue;
    }
    const current = text.slice(found, found + ref.visible.length);
    if (current !== ref.visible) {
      edits.push({ start: found, end: found + current.length, text: ref.visible });
    }
  }
  let updated = text;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  }
  if (missing.length > 0) {
    // A sentence the ledger knows never reached the file. It goes back from the
    // ledger, which is the only place its text still exists.
    updated = restoreFrozenSentences(updated, refs).text;
  }
  return { text: updated, changed: updated !== text };
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
  let text = deps.readMemory(agent);
  // Repair the file against the ledger first: a previous tick whose write
  // failed left damage the file never showed, and planning from that file would
  // charge the same characters a second time. Only when something was repaired.
  if (deps.ledger.listActiveFrozenSentences(agent).length > 0) {
    const repaired = reconcileMemoryWithLedger(deps.ledger, agent, text);
    if (repaired.changed) {
      deps.writeMemory(agent, repaired.text);
      deps.blackbox.append(agent, 'memory_reconciled', at, null, { starvationSince, tickIndex });
      text = repaired.text;
    }
  }
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
  const rewrites: { start: number; end: number; text: string; sentenceId: number | null }[] = [];
  const locatedBefore = resolveFrozenLocations(
    text,
    active.map((item) => ({ id: item.record.id, visible: item.visible, startOffset: item.record.startOffset })),
  );
  deps.ledger.transaction(() => {
    for (const group of byUnit.values()) {
      const unit = group[0].unit;
      const original = unit.frozen === null ? unit.text : unit.frozen.original;
      const sentenceId =
        unit.frozen === null
          ? deps.ledger.insertFrozenSentence(agent, original, at, unit.start)
          : unit.frozen.id;
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
        sentenceId,
      });
    }

    // Where every active sentence sits in the text this tick is about to write.
    // The rewrite is pure, so the new text is computed here and the offsets are
    // recorded in the same transaction that records the wounds: a crash can
    // never leave the ledger pointing at a MEMORY that was never written.
    //
    // Each new offset is derived, not searched for: a sentence keeps its own
    // place, moved only by the length the rewrites above it added or removed.
    // Searching would be the very thing that confuses two identical sentences.
    const ordered = [...rewrites].sort((left, right) => left.start - right.start);
    const movedBy = (offset: number): number =>
      ordered
        .filter((rewrite) => rewrite.start < offset)
        .reduce((shift, rewrite) => shift + (rewrite.text.length - (rewrite.end - rewrite.start)), 0);
    for (const [id, offset] of locatedBefore) {
      deps.ledger.setFrozenSentenceOffset(id, offset + movedBy(offset));
    }
    for (const rewrite of ordered) {
      if (rewrite.sentenceId !== null) {
        deps.ledger.setFrozenSentenceOffset(rewrite.sentenceId, rewrite.start + movedBy(rewrite.start));
      }
    }
  });

  deps.writeMemory(agent, applyRewrites(text, rewrites));
  return { status: 'applied', wounds: created };
}

/** The text with each rewrite spliced in, latest first so offsets stay valid. */
function applyRewrites(text: string, rewrites: readonly { start: number; end: number; text: string }[]): string {
  let updated = text;
  for (const rewrite of [...rewrites].sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, rewrite.start) + rewrite.text + updated.slice(rewrite.end);
  }
  return updated;
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

/**
 * Where each ref sits in `text`, by id, never claiming the same characters
 * twice. Two refs whose `visible` is identical get their own places: the first
 * matching occurrence for one, the next for the other. That is the whole
 * difference between this and a plain `indexOf` per ref, which hands every
 * duplicate the same offset and loses all but one of them.
 */
function locateAll(text: string, refs: readonly FrozenRef[]): PlacedFrozen[] {
  const resolved = resolveFrozenLocations(
    text,
    refs.map((ref) => ({ id: ref.id, visible: ref.visible, startOffset: ref.startOffset ?? null })),
  );
  const out: PlacedFrozen[] = [];
  for (const ref of refs) {
    const at = resolved.get(ref.id);
    if (at !== undefined) {
      out.push({ ref, at });
    }
  }
  return out.sort((left, right) => left.at - right.at);
}

/** Every non-overlapping occurrence of `visible` in `text`, left to right. */
function occurrenceRanges(text: string, visible: string): Range[] {
  const out: Range[] = [];
  if (visible.length === 0) {
    return out;
  }
  let at = text.indexOf(visible);
  while (at >= 0) {
    out.push({ start: at, end: at + visible.length });
    at = text.indexOf(visible, at + visible.length);
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

/**
 * Where a sentence with no neighbour to sit after belongs: just inside the
 * long-term heading, so it lands in `# WHO I AM` rather than above it, outside
 * both sections. A file with no heading at all falls back to the second line.
 */
function headingAnchor(text: string): number {
  const lines = lineRanges(text);
  for (let index = 2; index < lines.length; index += 1) {
    const line = text.slice(lines[index].start, lines[index].end);
    if (/^#(?!#)/.test(line)) {
      return lines[index].end;
    }
  }
  return afterSecondLine(text);
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
 * Puts every frozen sentence back into a rewritten MEMORY.
 *
 * A sentence the model kept is kept; one it filled in is found by similarity
 * and swapped back; one it deleted is inserted after its neighbour in the old
 * order; and a placeholder the model invented is removed. Two identical
 * sentences each get an occurrence of their own, so neither is treated as the
 * other's duplicate, and a list the model reordered is put back into the
 * ledger's order. The model is never asked to preserve anything: the ledger is
 * what makes this hold.
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

    const anchor = placed.length > 0 ? lineEndAt(current, placed[placed.length - 1].at) : headingAnchor(current);
    current = `${current.slice(0, anchor)}\n${ref.visible}${current.slice(anchor)}`;
    inserted.push(ref.id);
    kept.push(ref);
  }

  // Every frozen sentence is in the text now. Two things are left: the extra
  // copies of a sentence the model invented, and the order of the ones it kept.
  const placed = locateAll(current, kept);
  const atOf = new Map<FrozenRef, number>();
  const owned = new Map<string, number[]>();
  for (const item of placed) {
    atOf.set(item.ref, item.at);
    const list = owned.get(item.ref.visible) ?? [];
    list.push(item.at);
    owned.set(item.ref.visible, list);
  }
  const slots = placed
    .map((item) => ({ start: item.at, end: item.at + item.ref.visible.length }))
    .sort((left, right) => left.start - right.start);
  // The slots are sorted and disjoint, so "is this range somebody's sentence?"
  // is a binary search for the last slot starting at or before it.
  const slotStarts = slots.map((slot) => slot.start);
  const insideAFrozenSentence = (range: Range): boolean => {
    let low = 0;
    let high = slotStarts.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (slotStarts[middle] <= range.start) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found >= 0 && range.end <= slots[found].end;
  };

  const edits: { start: number; end: number; text: string }[] = [];
  // The ledger knows how many sentences read a given way. Any further
  // occurrence is a copy the model wrote, whatever its neighbours look like:
  // deleting one of the ledger's own sentences as a "duplicate" is exactly the
  // bug this count prevents, and it is what used to drop the second of two
  // identical frozen sentences. An occurrence that sits inside another frozen
  // sentence is that sentence's own text and is left alone — a sentence made
  // entirely of placeholders is a substring of any longer run of them.
  for (const [visible, mine] of owned) {
    const claimed = new Set(mine);
    for (const range of occurrenceRanges(current, visible)) {
      if (!claimed.has(range.start) && !insideAFrozenSentence(range)) {
        edits.push({ start: range.start, end: range.end, text: '' });
        duplicatesRemoved += 1;
      }
    }
  }

  // Position is one of the three things the ledger promises to restore, so the
  // sentences go back in the ledger's order: the k-th sentence takes the k-th
  // slot, and each slot ends up holding the text the ledger says belongs there.
  // A slot is replaced whole, by the length of what stood there, because the
  // sentence moving in is rarely the same length as the one moving out.
  const order = frozen.filter((ref) => atOf.has(ref));
  for (let index = 0; index < order.length; index += 1) {
    const ref = order[index];
    const slot = slots[index];
    if (slot === undefined) {
      continue;
    }
    if (slot.start !== atOf.get(ref)) {
      replaced.push(ref.id);
    }
    if (current.slice(slot.start, slot.end) !== ref.visible) {
      edits.push({ start: slot.start, end: slot.end, text: ref.visible });
    }
  }

  // A placeholder the model invented is not part of any frozen sentence, so it
  // goes; the ones inside a sentence are the sentence.
  let strayRemoved = 0;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] === PLACEHOLDER && !slots.some((range) => inside(range, index))) {
      edits.push({ start: index, end: index + 1, text: '' });
      strayRemoved += 1;
    }
  }
  return {
    text: applyEdits(current, edits),
    replaced,
    inserted,
    strayRemoved,
    duplicatesRemoved,
  };
}

/**
 * Replaces each edited range with its text in one left-to-right rebuild. The
 * ranges are the ones found in the original text, so cutting and inserting
 * never has to be re-based after every change. An edit that overlaps one
 * already taken is dropped: the earlier one wins.
 */
function applyEdits(text: string, edits: readonly { start: number; end: number; text: string }[]): string {
  const sorted = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let out = '';
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) {
      continue;
    }
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + text.slice(cursor);
}
