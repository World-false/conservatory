import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
   */
  erase(agent: string): void {
    if (!SAFE_AGENT_NAME.test(agent)) {
      throw new BlackboxError(`unsafe agent name for a black box path: ${agent}`);
    }
    const dir = this.dirOf(agent);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
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
