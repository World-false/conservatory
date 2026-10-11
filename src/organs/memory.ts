import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { RoundTranscript, SerializedMessage, ToolSchema } from '../agent/ipc';
import { agentHomeDir, agentMemoryPath, type RuntimePaths } from '../config';
import type { ModelClient } from '../model/client';
import type { Blackbox } from './blackbox';
import type { AgentRecord, Ledger } from './ledger';
import {
  PLACEHOLDER,
  frozenRefsFor,
  ledgerFrozenRefs,
  resolveFrozenLocations,
  restoreFrozenSentences,
  similarity,
  type FrozenRef,
  type Range,
} from './redaction';

export type MemoryOutcome =
  | { status: 'updated'; memory: string }
  | { status: 'rejected'; reason: string; pausedConservatory?: boolean }
  | { status: 'usage_missing' }
  | { status: 'model_error'; message: string };

/**
 * How many rejected edits one session may make before it is thrown away whole.
 * A memory model that keeps breaking frozen sentences is not one bad paragraph:
 * every partial edit of that session is suspect, so the session is discarded
 * and a fresh one starts from the text as it stood.
 */
export const MAX_SANDBOX_REJECTIONS_PER_SESSION = 5;

/**
 * How many sessions one memory step gets. When all of them fail the fault is in
 * the body rather than in the answer, so the round changes nothing and the
 * conservatory is paused for the operator to look at.
 */
export const MAX_MEMORY_SESSIONS_PER_ROUND = 3;

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
  /**
   * Called when every session of one memory step was thrown away, which is the
   * one condition that stops the whole conservatory: the memory model can no
   * longer be trusted to carry an agent across rounds at all.
   */
  onPauseConservatory?(agent: string, reason: string, at: number): void;
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
  '- compact: fold the rounds the caller shows you into the long-term part. The caller gives you the editing tools replace_in_memory, append_to_memory and finish_memory_edit, and the long-term text changes only through them. Never answer a compact request with the whole long-term text; call the tools and end with finish_memory_edit.',
  'Rules:',
  "- Write in the first person, as the agent's own record.",
  '- Record facts and commitments only. Do not invent a persona, a role, or a character, and do not evaluate the agent\'s personality.',
  '- Never write the Name or Born lines; the harness owns them.',
  '- Never write a heading of any kind, and never rewrite the whole file.',
  '- Leave every sentence that holds a \u25AE placeholder exactly as it stands. Copy it character for character: never fill it in, shorten it, or drop it.',
  '- The \u25AE is not yours to write: never put one into text you add, and never move, fill in or delete a sentence that already holds one. An edit that touches such a sentence, or new text containing a \u25AE, is refused and counts against you.',
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

function appendUserPrompt(oldMemory: string, transcript: RoundTranscript): string {
  const parts = [
    '=== CURRENT MEMORY ===',
    oldMemory.trimEnd(),
    '=== END CURRENT MEMORY ===',
    '',
    '=== THIS ROUND ===',
    renderTranscript(transcript),
    '=== END THIS ROUND ===',
    '',
    "Your job is APPEND. Write only the body of this round's new block: two to four first-person sentences about what happened, what I decided, and what I promised.",
    'Do not write a heading. Do not write the Name or Born lines. Do not repeat what MEMORY already holds, and do not rewrite the file.',
  ];
  return parts.join('\n');
}

function compactUserPrompt(who: string, folded: readonly string[]): string {
  const parts = [
    '=== THE LONG-TERM PART AS IT STANDS ===',
    who.trim() === '' ? '(nothing yet)' : who.trim(),
    '=== END THE LONG-TERM PART AS IT STANDS ===',
    '',
    '=== ROUNDS TO FOLD IN, OLDEST FIRST ===',
    folded.join('\n\n'),
    '=== END ROUNDS TO FOLD IN ===',
    '',
    'Your job is COMPACT. Fold what still matters from those rounds into my long-term memory.',
    'Use the editing tools you were given: replace_in_memory to rewrite or delete a healthy passage, append_to_memory to add a paragraph, and finish_memory_edit to commit.',
    'An answer that calls no tool at all is read as the complete new long-term text, so answer in plain text only if you cannot call tools.',
    'Keep every sentence that holds a \u25AE placeholder exactly as it stands, character for character.',
    'Do not write a heading, do not write the Name or Born lines, and do not write anything from the recent rounds.',
  ];
  return parts.join('\n');
}

/**
 * The one sentence the model is shown after a refusal. The reason is written
 * out in full because the next answer is the model's only chance to fix it, and
 * the session it is in is thrown away after five of these.
 */
function correctionPrompt(reason: string): string {
  return [
    `Your previous answer was rejected by the memory sandbox: ${reason}`,
    'Answer again, and obey every rule above. Nothing you wrote was kept.',
  ].join('\n');
}

// ------------------------------------------------------------- the model call

type CallResult =
  | { kind: 'ok'; raw: string; message: SerializedMessage }
  | { kind: 'usage_missing' }
  | { kind: 'model_error'; message: string };

type StepResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'usage_missing' }
  | { kind: 'model_error'; message: string }
  | { kind: 'rejected'; reason: string; pausedConservatory: boolean };

/** One memory-model call, with the usage and failure bookkeeping it owes. */
async function callMemoryModel(
  deps: MemoryDeps,
  transcript: RoundTranscript,
  messages: readonly SerializedMessage[],
  tools: readonly ToolSchema[] | null,
  attempt: number,
  step: 'append' | 'compact',
  session: number,
): Promise<CallResult> {
  const agent = transcript.agent;
  let response;
  try {
    response = await deps.model.chat({
      messages,
      ...(tools === null ? {} : { tools }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.blackbox.append(agent, 'memory_error', deps.now(), transcript.roundId, {
      attempt,
      step,
      session,
      message,
    });
    deps.onError(agent, `MEMORY model call failed: ${message}`);
    return { kind: 'model_error', message };
  }

  if (response.usage === null) {
    deps.blackbox.append(agent, 'usage_missing', deps.now(), transcript.roundId, {
      source: 'memory',
      attempt,
      step,
      session,
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
  return { kind: 'ok', raw: response.message.content ?? '', message: response.message };
}

/**
 * Ends a session and throws everything it did away: for `compact` the working
 * copy of the long-term part goes back to the file, and for both jobs the
 * conversation is dropped. The next session starts from the text as it stood,
 * which is what makes a partial edit unkeepable.
 *
 * `rejections` is the count this session really reached: five when it burned
 * its whole allowance, fewer when it merely ran on without ever producing an
 * answer worth keeping. Recording five in that second case would blame the
 * model for a refusal it never made.
 */
function endSession(
  deps: MemoryDeps,
  transcript: RoundTranscript,
  step: 'append' | 'compact',
  session: number,
  rejections: number,
  reason: string,
): void {
  deps.blackbox.append(transcript.agent, 'memory_session_reset', deps.now(), transcript.roundId, {
    session,
    rejections,
    step,
    reason,
  });
}

/**
 * The end of a memory step whose every session was thrown away. Nothing is
 * written, the operator is told, and the conservatory is paused: the memory
 * system is the thing that carries an agent between rounds, so one that cannot
 * do it is a body-level fault rather than a bad answer.
 */
function giveUp(
  deps: MemoryDeps,
  transcript: RoundTranscript,
  step: 'append' | 'compact',
  reason: string,
): StepResult<never> {
  deps.blackbox.append(transcript.agent, 'memory_sandbox_paused', deps.now(), transcript.roundId, {
    step,
    sessions: MAX_MEMORY_SESSIONS_PER_ROUND,
    rejectionsPerSession: MAX_SANDBOX_REJECTIONS_PER_SESSION,
    reason,
  });
  deps.onError(
    transcript.agent,
    `MEMORY ${step} was refused by the sandbox in all ${MAX_MEMORY_SESSIONS_PER_ROUND} sessions (${reason}); the old MEMORY was kept unchanged and the conservatory was paused.`,
  );
  deps.onPauseConservatory?.(transcript.agent, reason, deps.now());
  return { kind: 'rejected', reason, pausedConservatory: true };
}

// --------------------------------------------------------------- the sandbox

/**
 * The editing tools the compaction model is given. They exist because a model
 * that has to re-emit a long-term part in full will eventually re-emit a
 * wounded sentence with the gash smoothed over, and there is no way back from
 * that: the wounds are pinned to the text by offset. Editing in place makes
 * leaving a passage alone the default instead of an achievement.
 */
export const COMPACT_MEMORY_TOOLS: ToolSchema[] = [
  {
    name: 'replace_in_memory',
    description:
      'Replaces one exact passage of the long-term part with new text. The passage must occur exactly once. A sentence holding a \u25AE placeholder cannot be replaced or deleted, in whole or in part.',
    parameters: {
      type: 'object',
      properties: {
        old_text: {
          type: 'string',
          description: 'The exact passage to replace, copied character for character from the long-term part.',
        },
        new_text: {
          type: 'string',
          description: 'The text that takes its place. An empty string deletes the passage.',
        },
      },
      required: ['old_text', 'new_text'],
      additionalProperties: false,
    },
  },
  {
    name: 'append_to_memory',
    description: 'Appends a new paragraph to the end of the long-term part.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The paragraph to add.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish_memory_edit',
    description:
      'Commits the edits made so far and ends the compaction. Call it once, when the long-term part reads the way it should.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

/**
 * A session that keeps making valid edits without ever finishing is still
 * bounded. The limit is well above what folding ten rounds needs, so reaching
 * it means the model is looping rather than working.
 */
const MAX_MEMORY_CALLS_PER_SESSION = 20;

const PLACEHOLDER_REFUSAL = 'Sandbox rejected edit: do not write the \u25AE placeholder';
const HEADING_REFUSAL = 'Sandbox rejected edit: do not write a heading of any kind';
const ECHO_REFUSAL = 'Sandbox rejected edit: do not restate or rewrite a frozen sentence holding \u25AE';

function overlaps(left: Range, right: Range): boolean {
  return left.start < right.end && right.start < left.end;
}

/** True when the character `index` ends a sentence: `.`/`!`/`?` then whitespace or the end. */
function isSentenceEnd(text: string, index: number): boolean {
  const character = text[index];
  if (character !== '.' && character !== '!' && character !== '?') {
    return false;
  }
  return index + 1 >= text.length || /\s/.test(text[index + 1]);
}

/**
 * The sentence a matched span sits in, widened out from the span itself.
 *
 * The model edits by passage, and a passage is usually a fragment, so "is this
 * edit touching a frozen sentence?" cannot be answered on the fragment: a model
 * that replaces four characters in the middle of a wounded sentence has
 * rewritten that sentence just as surely as one that replaced the whole of it.
 * The span is widened to the sentence that holds it and the caller checks that.
 */
function enclosingSentence(text: string, start: number, end: number): Range {
  let left = start;
  while (left > 0) {
    const previous = text[left - 1];
    if (previous === '\n' || isSentenceEnd(text, left - 1)) {
      break;
    }
    left -= 1;
  }
  let right = Math.max(end, left);
  if (right > left && (text[right - 1] === '\n' || isSentenceEnd(text, right - 1))) {
    return { start: left, end: right };
  }
  while (right < text.length) {
    if (text[right] === '\n') {
      break;
    }
    if (isSentenceEnd(text, right)) {
      right += 1;
      break;
    }
    right += 1;
  }
  return { start: left, end: right };
}

/** Where each frozen sentence sits in `who`, by id. */
function locateInWho(who: string, whoRefs: readonly FrozenRef[]): Map<number, number> {
  return resolveFrozenLocations(
    who,
    whoRefs.map((ref) => ({ id: ref.id, visible: ref.visible, startOffset: null })),
  );
}

/** The frozen sentences that really sit between the two long-term headings. */
function frozenRefsInsideWho(parsed: ParsedMemory, refs: readonly FrozenRef[]): FrozenRef[] {
  if (parsed.who.trim() === '' || refs.length === 0) {
    return [];
  }
  const located = resolveFrozenLocations(
    parsed.text,
    refs.map((ref) => ({ id: ref.id, visible: ref.visible, startOffset: ref.startOffset ?? null })),
  );
  return refs.filter((ref) => {
    const at = located.get(ref.id);
    return at !== undefined && at >= parsed.whoStart && at + ref.visible.length <= parsed.whoEnd;
  });
}

/**
 * The first reason the sandbox refuses text the model wants to add, or null
 * when the text is acceptable. A model may write anything about the agent's
 * life; what it may not do is write a gash of its own, re-cut the file's
 * structure, or hand back a dressed-up copy of a sentence the ledger owns.
 */
function addedTextRefusal(text: string, refs: readonly FrozenRef[]): string | null {
  if (text.includes(PLACEHOLDER)) {
    return PLACEHOLDER_REFUSAL;
  }
  if (text.split('\n').some((line) => isLevelOne(line) || isLevelTwo(line))) {
    return HEADING_REFUSAL;
  }
  if (dropFrozenEchoes(text, refs).dropped.length > 0) {
    return ECHO_REFUSAL;
  }
  return null;
}

/**
 * The final gate before a compaction is committed.
 *
 * Everything the ledger froze is checked one last time, in the one place where
 * it still matters: the whole long-term part, after every edit. Each sentence
 * must still be there character for character, the same number of them must be
 * there, they must still come in the ledger's order, and no placeholder may
 * have appeared anywhere else. A model that rearranged two frozen sentences has
 * changed what the agent's memory says about its own past.
 */
function whoIntegrityRefusal(who: string, whoRefs: readonly FrozenRef[]): string | null {
  const body = who.trim();
  if (body === '') {
    return 'Sandbox rejected edit: the long-term part cannot be emptied';
  }
  const located = locateInWho(body, whoRefs);
  if (located.size !== whoRefs.length) {
    return 'Sandbox rejected edit: a frozen sentence was removed or altered; every sentence holding \u25AE must survive character for character';
  }
  const inOrder = [...whoRefs].sort(
    (left, right) => (located.get(left.id) as number) - (located.get(right.id) as number),
  );
  for (let index = 0; index < inOrder.length; index += 1) {
    if (inOrder[index].id !== whoRefs[index].id) {
      return 'Sandbox rejected edit: the frozen sentences were reordered; they must stay in the order the ledger holds them';
    }
  }
  const ranges: Range[] = whoRefs.map((ref) => {
    const at = located.get(ref.id) as number;
    return { start: at, end: at + ref.visible.length };
  });
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== PLACEHOLDER) {
      continue;
    }
    if (!ranges.some((range) => index >= range.start && index < range.end)) {
      return PLACEHOLDER_REFUSAL;
    }
  }
  return null;
}

/** A short, quotable form of a passage, for the message the model reads back. */
function quote(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

// ------------------------------------------------------------------- the jobs

/**
 * Step A: fold this round in by writing only its block onto the end.
 *
 * The heading is the harness's: the round id and the instant come from the
 * transcript, so the timestamp in the file is the round's own start and not
 * whatever the model guessed. A refused answer is shown back to the model with
 * the reason, and a session that spends its whole allowance of refusals is
 * thrown away and started over from the file as it stood.
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
  let lastReason = 'unknown';

  for (let session = 1; session <= MAX_MEMORY_SESSIONS_PER_ROUND; session += 1) {
    const messages: SerializedMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: appendUserPrompt(oldMemory, transcript) },
    ];
    let rejections = 0;

    for (let attempt = 1; attempt <= MAX_MEMORY_CALLS_PER_SESSION; attempt += 1) {
      const call = await callMemoryModel(deps, transcript, messages, null, attempt, 'append', session);
      if (call.kind !== 'ok') {
        return call;
      }
      messages.push(call.message);

      const extracted = roundBody(call.raw, agent, record.bornAt, transcript.roundId);
      deps.blackbox.append(agent, 'memory_response', deps.now(), transcript.roundId, {
        session,
        attempt,
        step: 'append',
        text: call.raw,
        enforced: extracted.kind === 'ok' ? `${heading}\n${extracted.body}` : '',
      });

      // A round block may not invent a gash, and it may not restate a sentence
      // the ledger owns: the wound is pinned to MEMORY by offset, so a copy of
      // a frozen sentence read as a healed one. Both are refusals rather than
      // quiet repairs, because the model is meant to learn the rule.
      const echoes = extracted.kind === 'ok' ? dropFrozenEchoes(extracted.body, refs).dropped : [];
      const body = extracted.kind === 'ok' ? extracted.body.trim() : '';
      let reason: string | null = null;
      if (extracted.kind === 'no') {
        reason = extracted.reason;
      } else if (echoes.length > 0) {
        reason = ECHO_REFUSAL;
      } else if (extracted.body.includes(PLACEHOLDER)) {
        reason = PLACEHOLDER_REFUSAL;
      } else if (body === '') {
        reason = 'the answer held nothing to remember';
      }
      if (reason !== null) {
        rejections += 1;
        lastReason = reason;
        deps.blackbox.append(agent, 'memory_rejected', deps.now(), transcript.roundId, {
          session,
          attempt: rejections,
          step: 'append',
          reason,
        });
        if (rejections >= MAX_SANDBOX_REJECTIONS_PER_SESSION) {
          break;
        }
        messages.push({ role: 'user', content: correctionPrompt(reason) });
        continue;
      }

      const block = `${heading}\n${body}`;
      const memory = appendBlock(agent, record.bornAt, parseMemory(oldMemory), block);
      deps.blackbox.append(agent, 'memory_appended', deps.now(), transcript.roundId, {
        session,
        attempt,
        round: transcript.roundId,
        startedAt: transcript.startedAt,
      });
      return { kind: 'ok', value: { memory, echoes } };
    }
    // Every session runs out the same way: five refusals, or a model that just
    // kept talking. Either way it is thrown away and the next one starts from
    // the file as it stood, with nothing this one wrote.
    endSession(deps, transcript, 'append', session, rejections, lastReason);
  }

  return giveUp(deps, transcript, 'append', lastReason);
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
  const whoRefs = frozenRefsInsideWho(parsed, refs);
  let lastReason = 'unknown';

  for (let session = 1; session <= MAX_MEMORY_SESSIONS_PER_ROUND; session += 1) {
    // The working copy is a session's own: it starts from the file every time,
    // so a session that is thrown away takes its partial edits with it.
    let workingWho = parsed.who.trim();
    let editedInSession = false;
    const messages: SerializedMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: compactUserPrompt(parsed.who, foldedText) },
    ];
    let rejections = 0;
    let finished: string | null = null;
    /**
     * Counts one refusal and writes it to the black box. The session's own
     * count is the `attempt` the operator sees, so a session that burned its
     * allowance reads 1..5 rather than 1..20.
     */
    const refuse = (reason: string): number => {
      rejections += 1;
      lastReason = reason;
      deps.blackbox.append(agent, 'memory_rejected', deps.now(), transcript.roundId, {
        session,
        attempt: rejections,
        step: 'compact',
        reason,
      });
      return rejections;
    };

    for (let attempt = 1; attempt <= MAX_MEMORY_CALLS_PER_SESSION; attempt += 1) {
      const call = await callMemoryModel(
        deps,
        transcript,
        messages,
        COMPACT_MEMORY_TOOLS,
        attempt,
        'compact',
        session,
      );
      if (call.kind !== 'ok') {
        return call;
      }
      messages.push(call.message);

      const calls = call.message.toolCalls ?? [];
      if (calls.length === 0) {
        // No tool call at all: read the answer as the complete long-term text,
        // which is how a provider that cannot call tools is still served. It is
        // held to exactly the same gate as the edits above.
        const extracted = compactBody(call.raw, agent, record.bornAt);
        const body = extracted.kind === 'ok' ? extracted.body.trim() : '';
        deps.blackbox.append(agent, 'memory_response', deps.now(), transcript.roundId, {
          session,
          attempt,
          step: 'compact',
          text: call.raw,
          enforced: body,
        });
        let reason: string | null = null;
        if (extracted.kind === 'no') {
          reason = extracted.reason;
        } else if (dropFrozenEchoes(body, refs).dropped.length > 0) {
          reason = ECHO_REFUSAL;
        } else {
          reason = whoIntegrityRefusal(body, whoRefs);
        }
        if (reason !== null) {
          rejections = refuse(reason);
          if (rejections >= MAX_SANDBOX_REJECTIONS_PER_SESSION) {
            break;
          }
          messages.push({ role: 'user', content: correctionPrompt(reason) });
          continue;
        }
        workingWho = body;
        finished = workingWho;
        break;
      }

      // A batch is all-or-nothing: the edits are made to a candidate copy and
      // only adopted once every call in the batch has passed. A refusal in the
      // fourth call must not leave the first three applied, or "the sandbox
      // rejected the edit" would not be true of the session's own state.
      let candidate: string = workingWho;
      let candidateEdited: boolean = editedInSession;
      let refusal: string | null = null;
      let done: string | null = null;
      const results: SerializedMessage[] = [];
      for (const tool of calls) {
        const args = parseToolArguments(tool.argumentsJson);
        if (tool.name === 'finish_memory_edit') {
          const gate = !candidateEdited
            ? 'Sandbox rejected edit: make at least one edit before finishing'
            : whoIntegrityRefusal(candidate, whoRefs);
          if (gate !== null) {
            refusal = gate;
            break;
          }
          done = candidate.trim();
          results.push(toolResult(tool.id, null));
          break;
        }
        if (tool.name === 'append_to_memory' && args !== null) {
          const text = readArgument(args, 'text');
          if (text === null || text.trim() === '') {
            refusal = 'Sandbox rejected edit: text must be a non-empty string';
            break;
          }
          const bad = addedTextRefusal(text, refs);
          if (bad !== null) {
            refusal = bad;
            break;
          }
          const trimmed = text.trim();
          candidate = candidate === '' ? trimmed : `${candidate}\n\n${trimmed}`;
          candidateEdited = true;
          results.push(toolResult(tool.id, null));
          continue;
        }
        if (tool.name === 'replace_in_memory' && args !== null) {
          const oldText = readArgument(args, 'old_text');
          const newText = readArgument(args, 'new_text');
          if (oldText === null || oldText.trim() === '') {
            refusal = 'Sandbox rejected edit: old_text must be a non-empty string';
            break;
          }
          if (newText === null) {
            refusal = 'Sandbox rejected edit: new_text must be a string';
            break;
          }
          const first = candidate.indexOf(oldText);
          if (first < 0) {
            refusal = 'Sandbox rejected edit: old_text was not found in # WHO I AM';
            break;
          }
          if (candidate.indexOf(oldText, first + 1) >= 0) {
            refusal =
              'Sandbox rejected edit: old_text matched multiple places in # WHO I AM; include more surrounding context';
            break;
          }
          // The fragment is widened to its sentence before the frozen check:
          // editing part of a wounded sentence rewrites the sentence, and a
          // gash is pinned to the text by offset, so a rewrite of any part of
          // it destroys the record.
          const sentence = enclosingSentence(candidate, first, first + oldText.length);
          const located = locateInWho(candidate, whoRefs);
          const hit = whoRefs.find((ref) => {
            const at = located.get(ref.id);
            return at !== undefined && overlaps(sentence, { start: at, end: at + ref.visible.length });
          });
          const held = candidate.slice(sentence.start, sentence.end);
          if (hit !== undefined || held.includes(PLACEHOLDER)) {
            refusal =
              `Sandbox rejected edit: the target sentence contains a '\u25AE' placeholder or wound ("${quote(held)}") and is frozen. ` +
              "Sentences holding '\u25AE' cannot be modified, filled in, or deleted. Adjust old_text to edit only healthy sentences.";
            break;
          }
          if (newText.trim() === '' && candidate.replace(oldText, '').trim() === '') {
            refusal = 'Sandbox rejected edit: the long-term part cannot be emptied';
            break;
          }
          const bad = newText.trim() === '' ? null : addedTextRefusal(newText, refs);
          if (bad !== null) {
            refusal = bad;
            break;
          }
          candidate = candidate.slice(0, first) + newText + candidate.slice(first + oldText.length);
          candidateEdited = true;
          results.push(toolResult(tool.id, null));
          continue;
        }
        refusal = `Sandbox rejected edit: "${tool.name}" is not an editing tool, or its arguments were unusable`;
        break;
      }

      if (refusal === null) {
        workingWho = candidate;
        editedInSession = candidateEdited;
        messages.push(...results);
        if (done !== null) {
          finished = done;
          break;
        }
        continue;
      }

      rejections = refuse(refusal);
      if (rejections >= MAX_SANDBOX_REJECTIONS_PER_SESSION) {
        break;
      }
      // Every call in the batch gets an answer, because the API requires one
      // result per call. A call that had already passed is told the truth about
      // what became of it: the batch was rolled back as a whole, so its edit is
      // not in the working copy either.
      const answered = new Set(results.map((result) => result.toolCallId));
      messages.push(
        ...calls.map((tool) =>
          toolResult(tool.id, answered.has(tool.id) ? `the batch was rolled back: ${refusal}` : refusal),
        ),
      );
      messages.push({ role: 'user', content: correctionPrompt(refusal) });
    }

    if (finished !== null) {
      const edits = [
        { start: parsed.whoStart, end: parsed.whoEnd, text: `${finished}\n\n` },
        ...folded.map((block) => ({ start: block.start, end: block.end, text: '' })),
      ].sort((left, right) => right.start - left.start);
      let memory = parsed.text;
      for (const edit of edits) {
        memory = memory.slice(0, edit.start) + edit.text + memory.slice(edit.end);
      }
      memory = `${memory.replace(/\s+$/u, '')}\n`;
      deps.blackbox.append(agent, 'memory_compacted', deps.now(), transcript.roundId, {
        session,
        folded: folded.length,
        kept: parsed.rounds.length - folded.length,
      });
      return { kind: 'ok', value: { memory, echoes: [] } };
    }
    // The session is thrown away whole, partial edits included: a model that
    // broke a frozen sentence five times has not made one bad guess, and the
    // paragraphs it got right came out of the same run.
    endSession(deps, transcript, 'compact', session, rejections, lastReason);
  }

  return giveUp(deps, transcript, 'compact', lastReason);
}

/**
 * One tool result, in the shape `toSdkMessages` expects to send back. A refusal
 * is a normal result of the call rather than a transport failure, so it carries
 * `ok: false` and the reason, which is what the model reads before answering
 * again.
 */
function toolResult(callId: string, error: string | null): SerializedMessage {
  return {
    role: 'tool',
    toolCallId: callId,
    content: JSON.stringify(error === null ? { ok: true } : { ok: false, error }),
  };
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function readArgument(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
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
 *
 * A step whose every session was refused writes nothing at all: the file stays
 * exactly as it was, so a memory system that has broken down can never leave a
 * half-folded MEMORY behind. The round's own transcript is still in the black
 * box, and the conservatory is paused for the operator.
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
    return { status: 'rejected', reason: appended.reason, pausedConservatory: appended.pausedConservatory };
  }
  let text = appended.value.memory;
  const echoes = [...appended.value.echoes];
  // Set when the compaction ran out of sessions. The append above is a separate
  // step that succeeded, so the round is still written; it is the folding that
  // is abandoned, leaving `# WHO I AM` exactly as it stood.
  let compactionPause: string | null = null;

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
      } else if (compacted.kind === 'rejected') {
        // A refused compaction costs nothing but the compression: the round was
        // already folded in, and the older blocks stay where they are. When
        // every session failed the conservatory is paused as well, so the
        // operator can look before another round is folded onto a long-term
        // part the memory model has just proved it cannot edit.
        compactionPause = compacted.pausedConservatory ? compacted.reason : null;
      }
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

  // Where every frozen sentence sits in the text about to be written, so the
  // next rewrite and the next redaction start from the truth rather than from
  // whatever the model answered.
  const located = resolveFrozenLocations(
    text,
    ledgerFrozenRefs(deps.ledger, agent).map((ref) => ({
      id: ref.id,
      visible: ref.visible,
      startOffset: ref.startOffset ?? null,
    })),
  );
  for (const [id, at] of located) {
    deps.ledger.setFrozenSentenceOffset(id, at);
  }

  writeMemoryAtomic(deps.paths, agent, text);
  deps.blackbox.append(agent, 'memory_new', deps.now(), transcript.roundId, { text });
  if (compactionPause !== null) {
    // The round itself was folded in and is written. What failed is the folding
    // of the older rounds, which is the part the memory model has to be able to
    // do at all: the conservatory is paused and the operator decides.
    return { status: 'rejected', reason: compactionPause, pausedConservatory: true };
  }
  return { status: 'updated', memory: text };
}
