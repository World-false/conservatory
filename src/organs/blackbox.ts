import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export class BlackboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlackboxError';
  }
}

export interface BlackboxEntry {
  at: number;
  agent: string;
  round: number | null;
  kind: string;
  [key: string]: unknown;
}

export interface BlackboxRound {
  round: number | null;
  entries: BlackboxEntry[];
}

const SAFE_AGENT_NAME = /^[a-z0-9_]+$/;

/** The directory under the black-box root that holds dead agents' logs. */
export const ARCHIVE_DIR_NAME = 'ARCHIVE';

/**
 * The black box is the complete durable log: append-only JSON Lines, one file
 * per agent per UTC day. The agent never sees it; the operator sees all of it.
 */
export class Blackbox {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  append(
    agent: string,
    kind: string,
    at: number,
    round: number | null,
    data: Record<string, unknown>,
  ): void {
    const file = this.filePath(agent, at);
    mkdirSync(path.dirname(file), { recursive: true });
    const entry: BlackboxEntry = { ...data, at, agent, round, kind };
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Absolute path of the file an entry for this agent and instant lands in. */
  filePath(agent: string, at: number): string {
    if (!SAFE_AGENT_NAME.test(agent)) {
      throw new BlackboxError(`unsafe agent name for a black box path: ${agent}`);
    }
    const day = new Date(at).toISOString().slice(0, 10);
    return path.join(this.rootDir, agent, `${day}.jsonl`);
  }

  /** The directory holding every day file of one agent. */
  dirOf(agent: string): string {
    if (!SAFE_AGENT_NAME.test(agent)) {
      throw new BlackboxError(`unsafe agent name for a black box path: ${agent}`);
    }
    return path.join(this.rootDir, agent);
  }

  /** Day ids present for this agent, oldest first, without the file extension. */
  listDays(agent: string): string[] {
    const dir = path.join(this.rootDir, agent);
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .sort();
  }

  readDay(agent: string, day: string): BlackboxEntry[] {
    const file = path.join(this.rootDir, agent, `${day}.jsonl`);
    if (!existsSync(file)) {
      return [];
    }
    return parseLines(readFileSync(file, 'utf8'), file);
  }

  /**
   * Removes every day file this agent ever wrote. The black box is append-only
   * while an agent exists, and the one caller is total erasure: an agent that
   * never existed has no transcript. The name is validated first, because the
   * path is derived from it.
   *
   * The archive goes with it. Erasure is the one action that destroys history,
   * and leaving a copy under `ARCHIVE/` would make that a fiction.
   */
  erase(agent: string): void {
    if (!SAFE_AGENT_NAME.test(agent)) {
      throw new BlackboxError(`unsafe agent name for a black box path: ${agent}`);
    }
    const dir = this.dirOf(agent);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    const archive = this.archiveDirOf(agent);
    if (existsSync(archive)) {
      rmSync(archive, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }

  /**
   * Where a dead agent's log is kept: under `ARCHIVE/`, a sibling of the live
   * boxes, so the path is derivable from the conservatory root.
   *
   * The live box is never deleted at death — the design promises the transcript
   * survives — but "survives" was only ever implemented as "we did not remove
   * it". A day file in the live tree is one directory the supervisor also
   * writes, and nothing distinguished it from a log still being appended. The
   * archive is the written-down copy: byte-identical, out of the tree the
   * supervisor logs into, and named so the operator can find it.
   */
  archiveDirOf(agent: string): string {
    if (!SAFE_AGENT_NAME.test(agent)) {
      throw new BlackboxError(`unsafe agent name for a black box path: ${agent}`);
    }
    return path.join(this.rootDir, ARCHIVE_DIR_NAME, agent);
  }

  /**
   * Copies every day file of a dead agent into the archive and returns what it
   * wrote. Idempotent: running it twice leaves the same bytes in the same place,
   * so a retried death does not fail on its own archive.
   */
  archive(agent: string): string[] {
    const written: string[] = [];
    const days = this.listDays(agent);
    if (days.length === 0) {
      return written;
    }
    const target = this.archiveDirOf(agent);
    mkdirSync(target, { recursive: true });
    for (const day of days) {
      const source = path.join(this.dirOf(agent), `${day}.jsonl`);
      const copy = path.join(target, `${day}.jsonl`);
      copyFileSync(source, copy);
      written.push(copy);
    }
    return written;
  }

  /** The most recent rounds, oldest first, for the operator's viewer. */
  readRecentRounds(agent: string, roundCount: number): BlackboxRound[] {
    const days = this.listDays(agent);
    const collected: BlackboxEntry[] = [];
    const seenRounds = new Set<number>();
    for (let index = days.length - 1; index >= 0; index -= 1) {
      const entries = this.readDay(agent, days[index]);
      collected.unshift(...entries);
      for (const entry of entries) {
        if (typeof entry.round === 'number') {
          seenRounds.add(entry.round);
        }
      }
      if (seenRounds.size >= roundCount) {
        break;
      }
    }
    const groups = new Map<number | null, BlackboxEntry[]>();
    for (const entry of collected) {
      const key = entry.round;
      const bucket = groups.get(key);
      if (bucket === undefined) {
        groups.set(key, [entry]);
      } else {
        bucket.push(entry);
      }
    }
    const rounds: BlackboxRound[] = [];
    for (const [round, entries] of groups) {
      rounds.push({ round, entries });
    }
    return rounds.slice(Math.max(0, rounds.length - roundCount));
  }
}

function parseLines(text: string, file: string): BlackboxEntry[] {
  const out: BlackboxEntry[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BlackboxError(`black box file ${file} line ${index + 1} is not valid JSON: ${detail}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BlackboxError(`black box file ${file} line ${index + 1} is not a JSON object`);
    }
    out.push(parsed as BlackboxEntry);
  }
  return out;
}
