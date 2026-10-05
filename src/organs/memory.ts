import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { RoundTranscript } from '../agent/ipc';
import { agentHomeDir, agentMemoryPath, type RuntimePaths } from '../config';
import type { ModelClient } from '../model/client';
import type { Blackbox } from './blackbox';
import type { AgentRecord, Ledger } from './ledger';
import { PLACEHOLDER, frozenRefsFor, restoreFrozenSentences, similarity, type FrozenRef } from './redaction';

export type MemoryOutcome =
  | { status: 'updated'; memory: string }
  | { status: 'rejected'; reason: string }
  | { status: 'usage_missing' }
  | { status: 'model_error'; message: string };

export interface MemoryDeps {
  ledger: Ledger;
  blackbox: Blackbox;
  paths: RuntimePaths;
  /**
   * The character cap on the whole file. It is a target, not a gate: a round
   * that pushes MEMORY past it is still folded in, and the operator is told.
   */
  capChars: number;
  model: ModelClient;
  /**
   * The memory system prompt for this call. The caller loads it from
   * prompts/memory_system.md; the copy in this file is the fallback used when
   * that file is missing or unusable.
   */
  systemPrompt: string;
  now(): number;
  onError(agent: string, message: string): void;
}

/**
 * How many round blocks `# RECENT ROUNDS` holds before the oldest are folded
 * into `# WHO I AM`. The point of the limit is that MEMORY can grow to its cap
 * while every single model call stays small: a round costs a few hundred
 * tokens, and only the oldest few are ever rewritten.
 */
export const MAX_RECENT_ROUNDS = 10;

export const WHO_I_AM_HEADING = '# WHO I AM';
export const RECENT_ROUNDS_HEADING = '# RECENT ROUNDS';

export function isoTime(at: number): string {
  return new Date(at).toISOString();
}

/** A newborn's MEMORY holds only its name and birth time. */
export function newbornMemory(name: string, bornAt: number): string {
  return `Name: ${name}\nBorn: ${isoTime(bornAt)}\n`;
}

function headerOf(name: string, bornAt: number): string {
  return `Name: ${name}\nBorn: ${isoTime(bornAt)}`;
}

/**
 * The first two lines belong to the harness, not the model. Any header lines
 * the model produced are dropped and the true ones are restored before the
 * text is measured or written.
 */
export function enforceHeader(text: string, name: string, bornAt: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < lines.length && /^\s*(name|born)\s*:/i.test(lines[start])) {
    start += 1;
  }
  const body = lines.slice(start).join('\n').replace(/^\n+/, '');
  const header = headerOf(name, bornAt);
  if (body.trim() === '') {
    return `${header}\n`;
  }
  return `${header}\n${body}`;
}

/**
 * The model's answer with the harness header removed, whenever the model wrote
 * one anyway. It goes through `enforceHeader` so there is exactly one rule for
 * "what counts as a header line" in the whole file.
 */
function bodyOf(text: string, name: string, bornAt: number): string {
  const header = headerOf(name, bornAt);
  const enforced = enforceHeader(text, name, bornAt);
  if (enforced === `${header}\n`) {
    return '';
  }
  return enforced.slice(header.length + 1);
}

export function readMemoryFile(paths: RuntimePaths, name: string): string {
  const file = agentMemoryPath(paths, name);
  if (!existsSync(file)) {
    return '';
  }
  return readFileSync(file, 'utf8');
}

/** MEMORY is written by temp file plus rename, so no round ever sees a torn file. */
export function writeMemoryAtomic(paths: RuntimePaths, name: string, text: string): void {
  mkdirSync(agentHomeDir(paths, name), { recursive: true });
  const target = agentMemoryPath(paths, name);
  const temp = `${target}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, target);
}

function renderEntry(entry: RoundTranscript['entries'][number]): string {
  if (entry.kind === 'assistant') {
    return `ASSISTANT: ${entry.content === null || entry.content.trim() === '' ? '(no text)' : entry.content}`;
  }
  if (entry.kind === 'tool_call') {
    return `TOOL CALL ${entry.name} ${entry.argumentsJson}`;
  }
  return `TOOL RESULT ${entry.name}${entry.isError ? ' (error)' : ''}: ${entry.content}`;
}

export function renderTranscript(transcript: RoundTranscript): string {
  const lines: string[] = [];
  lines.push(`Round ${transcript.roundId}, started ${isoTime(transcript.startedAt)}, ended ${isoTime(transcript.endedAt)}.`);
  lines.push(`How the round ended: ${transcript.endReason}.`);
  for (const entry of transcript.entries) {
    lines.push(renderEntry(entry));
  }
  lines.push(
    `FINAL REPLY: ${
      transcript.finalReply === null || transcript.finalReply.trim() === ''
        ? '(none)'
        : transcript.finalReply
    }`,
  );
  return lines.join('\n');
}

/**
 * The built-in memory system prompt. The operator's editable copy lives in
 * prompts/memory_system.md; this one is the fallback so a deleted file can
 * never leave the harness without a prompt.
 */
export const MEMORY_SYSTEM_PROMPT = [
  'You are the memory system of the Conservatory. You are not the agent; you maintain the one file that carries the agent between rounds.',
  "MEMORY is a first-person record of the agent's life: facts about what happened to it, and commitments it made. It has two parts: the long-term part, and the recent rounds.",
  'The caller tells you in every request which single job to do, and you never do more than that job:',
  '- append: fill in the round that just ended. Write only its body.',
  '- compact: fold the rounds the caller shows you into the long-term part. Write only the new long-term text.',
  'Rules:',
  "- Write in the first person, as the agent's own record.",
  '- Record facts and commitments only. Do not invent a persona, a role, or a character, and do not evaluate the agent\'s personality.',
  '- Never write the Name or Born lines; the harness owns them.',
  '- Never write a heading of any kind, and never rewrite the whole file.',
  '- Leave every sentence that holds a \u25AE placeholder exactly as it stands. Copy it character for character: never fill it in, shorten it, or drop it.',
  '- Output only the text you were asked for. No preamble, no explanation, no code fences.',
].join('\n');

// ------------------------------------------------------------------ the file

/** One `## Round N — time` block, located by offset so it can be re-emitted verbatim. */
export interface RoundBlock {
  start: number;
  end: number;
}

export interface ParsedMemory {
  /** The text with CRLF normalised to LF, which is what every offset below uses. */
  text: string;
  /** True when both section headings are present, so appending is a tail write. */
  canonical: boolean;
  who: string;
  whoStart: number;
  whoEnd: number;
  recentPreamble: string;
  rounds: RoundBlock[];
}

function isLevelOne(line: string): boolean {
  return /^#(?!#)/.test(line);
}

function isLevelTwo(line: string): boolean {
  return /^##(?!#)/.test(line);
}

function splitLines(text: string): { raw: string; start: number; end: number }[] {
  const out: { raw: string; start: number; end: number }[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === '\n') {
      out.push({ raw: text.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  return out;
}

/**
 * Reads the file back into its two sections. The harness writes the headings,
 * so the structure is found by heading level and never by heading text: a wound
 * can land inside `RECENT ROUNDS` and leave it unreadable, and the file must
 * still parse. A file from an older version, or a newborn's, has no headings at
 * all, and what it holds is read as long-term memory.
 */
export function parseMemory(raw: string): ParsedMemory {
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = splitLines(text);
  let first = 0;
  while (first < lines.length && /^\s*(name|born)\s*:/i.test(lines[first].raw)) {
    first += 1;
  }
  const bodyStart = first < lines.length ? lines[first].start : text.length;

  const level1: number[] = [];
  const level2: number[] = [];
  for (let index = first; index < lines.length; index += 1) {
    if (isLevelTwo(lines[index].raw)) {
      level2.push(index);
    } else if (isLevelOne(lines[index].raw)) {
      level1.push(index);
    }
  }

  const whoHeading = level1.length >= 1 ? level1[0] : null;
  const roundsHeading = level1.length >= 2 ? level1[1] : null;
  const firstBlock = level2.length >= 1 ? level2[0] : null;

  if (whoHeading !== null && roundsHeading !== null) {
    const whoStart = lines[whoHeading].end + 1;
    const whoEnd = lines[roundsHeading].start;
    const blocksStart =
      firstBlock !== null && firstBlock > roundsHeading ? lines[firstBlock].start : text.length;
    return {
      text,
      canonical: true,
      who: text.slice(whoStart, whoEnd),
      whoStart,
      whoEnd,
      recentPreamble: text.slice(lines[roundsHeading].end + 1, blocksStart),
      rounds:
        firstBlock !== null && firstBlock > roundsHeading
          ? collectBlocks(lines, level2, text.length)
          : [],
    };
  }

  if (whoHeading !== null) {
    // One heading and round blocks under it: the long-term heading was never
    // written, so the blocks are still the recent rounds and there is no
    // long-term text to speak of.
    if (firstBlock !== null && firstBlock > whoHeading) {
      return {
        text,
        canonical: false,
        who: '',
        whoStart: 0,
        whoEnd: 0,
        recentPreamble: text.slice(lines[whoHeading].end + 1, lines[firstBlock].start),
        rounds: collectBlocks(lines, level2, text.length),
      };
    }
    const whoStart = lines[whoHeading].end + 1;
    return {
      text,
      canonical: false,
      who: text.slice(whoStart),
      whoStart,
      whoEnd: text.length,
      recentPreamble: '',
      rounds: [],
    };
  }

  return {
    text,
    canonical: false,
    who: text.slice(bodyStart),
    whoStart: bodyStart,
    whoEnd: text.length,
    recentPreamble: '',
    rounds: [],
  };
}

function collectBlocks(
  lines: { raw: string; start: number; end: number }[],
  level2: readonly number[],
  sectionEnd: number,
): RoundBlock[] {
  const out: RoundBlock[] = [];
  for (let index = 0; index < level2.length; index += 1) {
    const start = lines[level2[index]].start;
    const end = index + 1 < level2.length ? lines[level2[index + 1]].start : sectionEnd;
    out.push({ start, end });
  }
  return out;
}

/** The canonical file, built from parts. Used once, when a file has no headings. */
function assembleMemory(name: string, bornAt: number, parsed: ParsedMemory, block: string): string {
  const lines = [headerOf(name, bornAt), '', WHO_I_AM_HEADING];
  const who = parsed.who.trim();
  if (who !== '') {
    lines.push(who);
  }
  lines.push('', RECENT_ROUNDS_HEADING);
  const preamble = parsed.recentPreamble.trim();
  if (preamble !== '') {
    lines.push(preamble);
  }
  for (const round of parsed.rounds) {
    lines.push('', parsed.text.slice(round.start, round.end).trim());
  }
  lines.push('', block);
  return `${lines.join('\n')}\n`;
}

/**
 * Turns the model's block into something that can be written straight onto the
 * end of the file. A file that already holds both headings is only ever added
 * to; a file that does not is shaped once, without losing a character of what
 * it held.
 */
function appendBlock(
  name: string,
  bornAt: number,
  parsed: ParsedMemory,
  block: string,
): string {
  if (parsed.canonical) {
    return `${parsed.text.replace(/\s+$/u, '')}\n\n${block}\n`;
  }
  return assembleMemory(name, bornAt, parsed, block);
}

/** The sentences of one line, cut after each `[.!?]` that ends it. */
function sentenceFragments(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const terminator = character === '.' || character === '!' || character === '?';
    if (terminator && (index + 1 >= text.length || /\s/.test(text[index + 1]))) {
      out.push(text.slice(start, index + 1).trim());
      start = index + 1;
    }
  }
  if (start < text.length) {
    out.push(text.slice(start).trim());
  }
  return out.filter((piece) => piece !== '');
}

/**
 * Drops the part of the model's answer that is a rewritten copy of a frozen
 * sentence. The model never sees the true text, so a line close to one can only
 * be a guess dressed up as a memory, and left in place it would read as a wound
 * healed behind the ledger's back. A copy that is exact is kept: it is the
 * model obeying the prompt, and the ledger's own copy already stands in the
 * file. The comparison is per sentence, because the answer arrives as prose.
 */
function dropFrozenEchoes(text: string, refs: readonly FrozenRef[]): { text: string; dropped: number[] } {
  if (refs.length === 0) {
    return { text, dropped: [] };
  }
  const dropped: number[] = [];
  const echoOf = (piece: string): FrozenRef | null => {
    for (const ref of refs) {
      const visible = ref.visible.trim();
      if (visible === '' || piece === visible) {
        continue;
      }
      if (similarity(piece, visible) >= 0.5) {
        return ref;
      }
    }
    return null;
  };

  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      kept.push(line);
      continue;
    }
    const fragments = sentenceFragments(line);
    if (fragments.length <= 1) {
      // One sentence: the line stands or falls with it.
      const whole = echoOf(line.trim());
      if (whole !== null) {
        dropped.push(whole.id);
        continue;
      }
      kept.push(line);
      continue;
    }
    // Several sentences: drop only the ones that are echoes, so the rest of
    // what the model wrote for this round is not thrown away with them.
    const survivors = fragments.filter((piece) => {
      const echo = echoOf(piece);
      if (echo === null) {
        return true;
      }
      dropped.push(echo.id);
      return false;
    });
    if (survivors.length > 0) {
      kept.push(survivors.join(' '));
    }
  }
  return { text: kept.join('\n'), dropped };
}

/**
 * The body of the round the model was asked for, out of whatever it answered.
 *
 * The harness writes every heading, so a heading the model produced is never
 * kept: a level-one heading means it rewrote the file rather than one round,
 * and a `## Round N` heading means it answered with a whole block. Only the
 * block for this round is usable; a block naming an older round is the model
 * repeating history, and appending that would make the file say things twice.
 */
function roundBody(
  text: string,
  name: string,
  bornAt: number,
  roundId: number,
): { kind: 'ok'; body: string } | { kind: 'no'; reason: string } {
  const lines = bodyOf(text, name, bornAt).split('\n');
  if (lines.some((line) => isLevelOne(line))) {
    return { kind: 'no', reason: 'the answer rewrote the whole file instead of one round' };
  }
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter((item) => /^##\s+Round\s+\d+/i.test(item.line));
  if (headings.length === 0) {
    return usableBody(lines.filter((line) => !isLevelTwo(line)));
  }
  const mine = headings.find(
    (item) => Number(/^##\s+Round\s+(\d+)/i.exec(item.line)?.[1]) === roundId,
  );
  if (mine === undefined) {
    return { kind: 'no', reason: 'the answer repeated an older round instead of writing this one' };
  }
  const next = lines.findIndex(
    (line, index) => index > mine.index && (isLevelOne(line) || isLevelTwo(line)),
  );
  return usableBody(lines.slice(mine.index + 1, next === -1 ? lines.length : next));
}

/** The new long-term text, out of whatever the model answered. */
function compactBody(
  text: string,
  name: string,
  bornAt: number,
): { kind: 'ok'; body: string } | { kind: 'no'; reason: string } {
  let lines = bodyOf(text, name, bornAt).split('\n');
  const at = lines.findIndex((line) => isLevelOne(line) || isLevelTwo(line));
  if (at >= 0) {
    // The request says to write the long-term part, so a model that echoes its
    // heading is still answering the question. Anything beyond that heading is
    // the file, not the section.
    if (!/^#\s+WHO\s+I\s+AM$/i.test(lines[at].trim())) {
      return { kind: 'no', reason: 'the answer wrote a heading of its own' };
    }
    lines = lines.slice(at + 1);
    if (lines.some((line) => isLevelOne(line) || isLevelTwo(line))) {
      return { kind: 'no', reason: 'the answer wrote more than the long-term part' };
    }
  }
  return usableBody(lines);
}

function usableBody(lines: readonly string[]): { kind: 'ok'; body: string } | { kind: 'no'; reason: string } {
  const body = lines.join('\n').trim();
  if (body === '') {
    return { kind: 'no', reason: 'the answer held nothing to remember' };
  }
  return { kind: 'ok', body };
}

// --------------------------------------------------------------- the prompts

function appendUserPrompt(
  oldMemory: string,
  transcript: RoundTranscript,
  correction: string | null,
): string {
  const parts = [
    '=== CURRENT MEMORY ===',
    oldMemory.trimEnd(),
    '=== END CURRENT MEMORY ===',
    '',
    '=== THIS ROUND ===',
    renderTranscript(transcript),
    '=== END THIS ROUND ===',
    '',
  ];
  if (correction !== null) {
    parts.push(`Your previous answer was rejected: ${correction}`);
    parts.push('Answer again.');
  }
  parts.push(
    "Your job is APPEND. Write only the body of this round's new block: two to four first-person sentences about what happened, what I decided, and what I promised.",
  );
  parts.push(
    'Do not write a heading. Do not write the Name or Born lines. Do not repeat what MEMORY already holds, and do not rewrite the file.',
  );
  return parts.join('\n');
}

function compactUserPrompt(
  who: string,
  folded: readonly string[],
  correction: string | null,
): string {
  const parts = [
    '=== THE LONG-TERM PART AS IT STANDS ===',
    who.trim() === '' ? '(nothing yet)' : who.trim(),
    '=== END THE LONG-TERM PART AS IT STANDS ===',
    '',
    '=== ROUNDS TO FOLD IN, OLDEST FIRST ===',
    folded.join('\n\n'),
    '=== END ROUNDS TO FOLD IN ===',
    '',
  ];
  if (correction !== null) {
    parts.push(`Your previous answer was rejected: ${correction}`);
    parts.push('Answer again.');
  }
  parts.push(
    'Your job is COMPACT. Fold what still matters from those rounds into my long-term memory, and write the complete new long-term text.',
  );
  parts.push(
    'Keep every sentence that holds a \u25AE placeholder exactly as it stands, character for character.',
  );
  parts.push(
    'Do not write a heading, do not write the Name or Born lines, and do not write anything from the recent rounds.',
  );
  return parts.join('\n');
}

// ------------------------------------------------------------- the model call

type CallResult =
  | { kind: 'ok'; raw: string }
  | { kind: 'usage_missing' }
  | { kind: 'model_error'; message: string };

type StepResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'usage_missing' }
  | { kind: 'model_error'; message: string }
  | { kind: 'rejected'; reason: string };

/** One memory-model call, with the usage and failure bookkeeping it owes. */
async function callMemoryModel(
  deps: MemoryDeps,
  transcript: RoundTranscript,
  systemPrompt: string,
  user: string,
  attempt: number,
  step: 'append' | 'compact',
): Promise<CallResult> {
  const agent = transcript.agent;
  let response;
  try {
    response = await deps.model.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: user },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.blackbox.append(agent, 'memory_error', deps.now(), transcript.roundId, { attempt, step, message });
    deps.onError(agent, `MEMORY model call failed: ${message}`);
    return { kind: 'model_error', message };
  }

  if (response.usage === null) {
    deps.blackbox.append(agent, 'usage_missing', deps.now(), transcript.roundId, {
      source: 'memory',
      attempt,
      step,
    });
    deps.ledger.appendUsage({
      agent,
      round: transcript.roundId,
      source: 'memory',
      promptTokens: null,
      completionTokens: null,
      at: deps.now(),
    });
    deps.onError(
      agent,
      `MEMORY model response carried no usage, so this ${step} step was refused; MEMORY keeps what it had.`,
    );
    return { kind: 'usage_missing' };
  }

  deps.ledger.appendUsage({
    agent,
    round: transcript.roundId,
    source: 'memory',
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    at: deps.now(),
  });
  return { kind: 'ok', raw: response.message.content ?? '' };
}

// ------------------------------------------------------------------- the jobs

/**
 * Step A: fold this round in by writing only its block onto the end.
 *
 * The heading is the harness's: the round id and the instant come from the
 * transcript, so the timestamp in the file is the round's own start and not
 * whatever the model guessed. One retry, and if the second answer is unusable
 * too the file is left exactly as it was.
 */
async function appendRound(
  deps: MemoryDeps,
  transcript: RoundTranscript,
  systemPrompt: string,
  oldMemory: string,
  record: AgentRecord,
): Promise<StepResult<{ memory: string; echoes: number[] }>> {
  const agent = transcript.agent;
  const refs = frozenRefsFor(deps.ledger, agent, oldMemory);
  const heading = `## Round ${transcript.roundId} — ${isoTime(transcript.startedAt)}`;
  let correction: string | null = null;
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const call = await callMemoryModel(
      deps,
      transcript,
      systemPrompt,
      appendUserPrompt(oldMemory, transcript, correction),
      attempt,
      'append',
    );
    if (call.kind !== 'ok') {
      return call;
    }

    const extracted = roundBody(call.raw, agent, record.bornAt, transcript.roundId);
    const cleared =
      extracted.kind === 'ok' ? dropFrozenEchoes(extracted.body, refs) : { text: '', dropped: [] };
    const body = cleared.text.trim();
    deps.blackbox.append(agent, 'memory_response', deps.now(), transcript.roundId, {
      attempt,
      step: 'append',
      text: call.raw,
      enforced: body === '' ? '' : `${heading}\n${body}`,
    });

    if (extracted.kind === 'no' || body === '') {
      lastReason =
        extracted.kind === 'no'
          ? extracted.reason
          : 'the answer only restated a sentence the ledger already holds';
      deps.blackbox.append(agent, 'memory_rejected', deps.now(), transcript.roundId, { attempt, reason: lastReason });
    } else {
      const block = `${heading}\n${body}`;
      const memory = appendBlock(agent, record.bornAt, parseMemory(oldMemory), block);
      deps.blackbox.append(agent, 'memory_appended', deps.now(), transcript.roundId, {
        attempt,
        round: transcript.roundId,
        startedAt: transcript.startedAt,
      });
      return { kind: 'ok', value: { memory, echoes: cleared.dropped } };
    }
    correction = lastReason;
  }

  deps.blackbox.append(agent, 'memory_rejected', deps.now(), transcript.roundId, {
    attempt: 2,
    reason: lastReason,
    keptOldMemory: true,
  });
  deps.onError(
    agent,
    `MEMORY update rejected twice (${lastReason}); the old MEMORY was kept unchanged.`,
  );
  return { kind: 'rejected', reason: lastReason };
}

/**
 * Step B: fold the oldest rounds into the long-term part.
 *
 * Only `# WHO I AM` and the chosen round blocks are touched; the rounds that
 * stay are sliced back in verbatim. A block that still shows a placeholder is
 * never chosen, because a wound is pinned to the ledger by character offset and
 * the one safe way to honour "position, length, emptiness" is not to rewrite
 * the sentence at all. The cost is that such a block waits until it heals, and
 * the round list may sit above its limit in the meantime.
 */
async function compactRecent(
  deps: MemoryDeps,
  transcript: RoundTranscript,
  systemPrompt: string,
  parsed: ParsedMemory,
  folded: readonly RoundBlock[],
  refs: readonly FrozenRef[],
  record: AgentRecord,
): Promise<StepResult<{ memory: string; echoes: number[] }>> {
  const agent = transcript.agent;
  const foldedText = folded.map((block) => parsed.text.slice(block.start, block.end).trim());
  let correction: string | null = null;
  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const call = await callMemoryModel(
      deps,
      transcript,
      systemPrompt,
      compactUserPrompt(parsed.who, foldedText, correction),
      attempt,
      'compact',
    );
    if (call.kind !== 'ok') {
      return call;
    }

    const extracted = compactBody(call.raw, agent, record.bornAt);
    const cleared =
      extracted.kind === 'ok' ? dropFrozenEchoes(extracted.body, refs) : { text: '', dropped: [] };
    const who = cleared.text.trim();
    deps.blackbox.append(agent, 'memory_response', deps.now(), transcript.roundId, {
      attempt,
      step: 'compact',
      text: call.raw,
      enforced: who,
    });

    if (extracted.kind === 'no' || who === '') {
      lastReason =
        extracted.kind === 'no'
          ? extracted.reason
          : 'the answer only restated a sentence the ledger already holds';
      deps.blackbox.append(agent, 'memory_rejected', deps.now(), transcript.roundId, {
        attempt,
        step: 'compact',
        reason: lastReason,
      });
    } else {
      const edits = [
        { start: parsed.whoStart, end: parsed.whoEnd, text: `${who}\n\n` },
        ...folded.map((block) => ({ start: block.start, end: block.end, text: '' })),
      ].sort((left, right) => right.start - left.start);
      let memory = parsed.text;
      for (const edit of edits) {
        memory = memory.slice(0, edit.start) + edit.text + memory.slice(edit.end);
      }
      memory = `${memory.replace(/\s+$/u, '')}\n`;
      deps.blackbox.append(agent, 'memory_compacted', deps.now(), transcript.roundId, {
        attempt,
        folded: folded.length,
        kept: parsed.rounds.length - folded.length,
      });
      return { kind: 'ok', value: { memory, echoes: cleared.dropped } };
    }
    correction = lastReason;
  }

  deps.blackbox.append(agent, 'memory_compaction_failed', deps.now(), transcript.roundId, {
    attempt: 2,
    reason: lastReason,
    keptAppendedMemory: true,
  });
  deps.onError(
    agent,
    `MEMORY compaction rejected twice (${lastReason}); this round was still written and the older rounds were kept.`,
  );
  return { kind: 'rejected', reason: lastReason };
}

/**
 * Folds one round into MEMORY, then folds the oldest rounds into the long-term
 * part when there are more than MAX_RECENT_ROUNDS of them.
 *
 * The file grows by one appended block per round, which is what lets MEMORY
 * reach its cap while every model answer stays small. Append never touches what
 * is already there. Compaction rewrites only the long-term part and discards
 * only the older blocks it folded in, and the ledger restores any frozen
 * sentence the model touched while doing it.
 */
export async function consolidateMemory(
  deps: MemoryDeps,
  transcript: RoundTranscript,
): Promise<MemoryOutcome> {
  const agent = transcript.agent;
  const record = deps.ledger.getAgent(agent);
  if (record === null) {
    return { status: 'model_error', message: `agent ${agent} is not in the ledger` };
  }
  const oldMemory = readMemoryFile(deps.paths, agent);
  deps.blackbox.append(agent, 'memory_old', deps.now(), transcript.roundId, { text: oldMemory });

  // An empty prompt would be a silently broken call, so the built-in one wins.
  const systemPrompt = deps.systemPrompt.trim() === '' ? MEMORY_SYSTEM_PROMPT : deps.systemPrompt;
  const refs = frozenRefsFor(deps.ledger, agent, oldMemory);

  const appended = await appendRound(deps, transcript, systemPrompt, oldMemory, record);
  if (appended.kind === 'usage_missing') {
    return { status: 'usage_missing' };
  }
  if (appended.kind === 'model_error') {
    return { status: 'model_error', message: appended.message };
  }
  if (appended.kind === 'rejected') {
    return { status: 'rejected', reason: appended.reason };
  }
  let text = appended.value.memory;
  const echoes = [...appended.value.echoes];

  // Step B, only when the round list has outgrown its limit. The blocks that
  // still hold a placeholder are skipped rather than folded, so the file may
  // keep more than the limit until those sentences heal.
  const parsed = parseMemory(text);
  const excess = parsed.rounds.length - MAX_RECENT_ROUNDS;
  if (parsed.canonical && excess > 0) {
    const foldable = parsed.rounds
      .slice(0, excess)
      .filter((block) => !parsed.text.slice(block.start, block.end).includes(PLACEHOLDER));
    if (foldable.length === 0) {
      deps.blackbox.append(agent, 'memory_compaction_skipped', deps.now(), transcript.roundId, {
        reason: 'every oldest round still holds a placeholder',
        excess,
      });
    } else {
      const compacted = await compactRecent(deps, transcript, systemPrompt, parsed, foldable, refs, record);
      if (compacted.kind === 'ok') {
        text = compacted.value.memory;
        echoes.push(...compacted.value.echoes);
      }
      // A refused compaction costs nothing but the compression: the round was
      // already folded in, and the older blocks stay where they are.
    }
  }

  // Step C: whatever the model did to a frozen sentence, the ledger says what
  // it really is, so the harness puts it back before the text is written.
  const restored = restoreFrozenSentences(text, refs);
  const replaced = [...echoes, ...restored.replaced];
  if (
    replaced.length > 0 ||
    restored.inserted.length > 0 ||
    restored.strayRemoved > 0 ||
    restored.duplicatesRemoved > 0
  ) {
    text = restored.text;
    deps.blackbox.append(agent, 'frozen_restored', deps.now(), transcript.roundId, {
      replaced,
      inserted: restored.inserted,
      strayRemoved: restored.strayRemoved,
      duplicatesRemoved: restored.duplicatesRemoved,
    });
  }

  // The cap is a target, not a gate. Rejecting here would throw away the only
  // record of a round the agent really lived, so it is written and the operator
  // is told the file has outgrown its budget.
  if (text.length > deps.capChars) {
    deps.blackbox.append(agent, 'memory_over_cap', deps.now(), transcript.roundId, {
      length: text.length,
      cap: deps.capChars,
    });
  }

  writeMemoryAtomic(deps.paths, agent, text);
  deps.blackbox.append(agent, 'memory_new', deps.now(), transcript.roundId, { text });
  return { status: 'updated', memory: text };
}
