import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { RoundTranscript } from '../agent/ipc';
import { agentHomeDir, agentMemoryPath, type RuntimePaths } from '../config';
import type { ModelClient } from '../model/client';
import type { Blackbox } from './blackbox';
import type { Ledger } from './ledger';

export type MemoryOutcome =
  | { status: 'updated'; memory: string }
  | { status: 'rejected'; reason: string }
  | { status: 'usage_missing' }
  | { status: 'model_error'; message: string };

export interface MemoryDeps {
  ledger: Ledger;
  blackbox: Blackbox;
  paths: RuntimePaths;
  capChars: number;
  model: ModelClient;
  now(): number;
  onError(agent: string, message: string): void;
}

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

function systemPrompt(): string {
  return [
    'You are the memory system of the Conservatory. You are not the agent; you maintain the one file that carries the agent between rounds.',
    'MEMORY is a first-person record of the agent\'s life: facts about what happened to it, and commitments it made.',
    'Rules:',
    '- Write in the first person, as the agent\'s own record.',
    '- Record facts and commitments only. Do not invent a persona, a role, or a character, and do not evaluate the agent\'s personality.',
    '- When the text would exceed the character cap, compress the older material into short points and keep recent material in more detail.',
    '- Keep the two header lines (Name and Born) exactly as given.',
    '- Output only the complete new MEMORY text. No preamble, no explanation, no code fences.',
  ].join('\n');
}

function userPrompt(oldMemory: string, transcript: RoundTranscript, capChars: number, correction: string | null): string {
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
  parts.push(`Output the complete new MEMORY text, at most ${capChars} characters.`);
  return parts.join('\n');
}

/**
 * Folds one round into MEMORY. The model gets one retry; if the text is still
 * unusable the old MEMORY is kept untouched and the operator is told, because
 * silent truncation would be a lie about the agent's own record.
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

  let correction: string | null = null;
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await deps.model.chat({
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt(oldMemory, transcript, deps.capChars, correction) },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.blackbox.append(agent, 'memory_error', deps.now(), transcript.roundId, { attempt, message });
      deps.onError(agent, `MEMORY model call failed: ${message}`);
      return { status: 'model_error', message };
    }

    if (response.usage === null) {
      deps.blackbox.append(agent, 'usage_missing', deps.now(), transcript.roundId, { source: 'memory', attempt });
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
        'MEMORY model response carried no usage, so this round was not folded in; MEMORY is unchanged.',
      );
      return { status: 'usage_missing' };
    }

    deps.ledger.appendUsage({
      agent,
      round: transcript.roundId,
      source: 'memory',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      at: deps.now(),
    });

    const raw = response.message.content ?? '';
    const candidate = enforceHeader(raw, agent, record.bornAt);
    deps.blackbox.append(agent, 'memory_response', deps.now(), transcript.roundId, {
      attempt,
      text: raw,
      enforced: candidate,
    });

    if (candidate.trim() === '' || candidate.trim() === headerOf(agent, record.bornAt).trim()) {
      lastReason = 'the text contained no memory beyond the header';
      deps.blackbox.append(agent, 'memory_rejected', deps.now(), transcript.roundId, {
        attempt,
        reason: lastReason,
      });
    } else if (candidate.length > deps.capChars) {
      lastReason = `the text was ${candidate.length} characters, over the cap of ${deps.capChars}`;
      deps.blackbox.append(agent, 'memory_rejected', deps.now(), transcript.roundId, {
        attempt,
        reason: lastReason,
      });
    } else {
      writeMemoryAtomic(deps.paths, agent, candidate);
      deps.blackbox.append(agent, 'memory_new', deps.now(), transcript.roundId, {
        text: candidate,
        attempt,
      });
      return { status: 'updated', memory: candidate };
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
  return { status: 'rejected', reason: lastReason };
}
