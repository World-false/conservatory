import { existsSync, mkdirSync } from 'node:fs';
import {
  agentHomeDir,
  agentNotebookDir,
  type ConservatoryValues,
  type RuntimePaths,
} from '../config';
import type { AgentRecord, Ledger } from './ledger';
import { newbornMemory, writeMemoryAtomic } from './memory';

export const AGENT_NAME_PATTERN = /^[a-z0-9_]+$/;

export type PopulationErrorCode = 'invalid_name' | 'name_taken' | 'no_free_slot' | 'home_exists';

export type CreateAgentResult =
  | { ok: true; agent: AgentRecord }
  | { ok: false; code: PopulationErrorCode };

export interface CreateAgentInput {
  name: string;
  model: string;
  now: number;
  ledger: Ledger;
  values: ConservatoryValues;
  paths: RuntimePaths;
}

/** The living-agent ceiling is the configured slot count; step 4 raises it. */
export function effectiveMaxSlots(values: ConservatoryValues): number {
  return values.maxSlots;
}

/**
 * Lists every living agent other than the one asking, so an agent can see who
 * else is in the conservatory without seeing anyone's files.
 */
export function listLivingOtherAgents(ledger: Ledger, currentAgent?: string): AgentRecord[] {
  return ledger
    .listAgents()
    .filter((agent) => agent.status === 'alive' && agent.name !== currentAgent);
}

export interface Slot {
  index: number;
  agent: AgentRecord | null;
}

export function listSlots(values: ConservatoryValues, ledger: Ledger): Slot[] {
  const total = effectiveMaxSlots(values);
  const living = ledger.listAgents().filter((agent) => agent.status === 'alive');
  const slots: Slot[] = [];
  for (let index = 0; index < total; index += 1) {
    slots.push({ index, agent: living[index] ?? null });
  }
  return slots;
}

/** Birth: a home, a MEMORY with only the header, and the first ledger rows. */
export function createAgent(input: CreateAgentInput): CreateAgentResult {
  const { ledger, values, paths, name, model, now } = input;
  if (!AGENT_NAME_PATTERN.test(name)) {
    return { ok: false, code: 'invalid_name' };
  }
  if (ledger.getAgent(name) !== null) {
    return { ok: false, code: 'name_taken' };
  }
  if (ledger.countAgentsByStatus('alive') >= effectiveMaxSlots(values)) {
    return { ok: false, code: 'no_free_slot' };
  }
  const home = agentHomeDir(paths, name);
  if (existsSync(home)) {
    return { ok: false, code: 'home_exists' };
  }

  mkdirSync(agentNotebookDir(paths, name), { recursive: true });
  writeMemoryAtomic(paths, name, newbornMemory(name, now));

  const agent: AgentRecord = { name, bornAt: now, model, status: 'alive' };
  ledger.transaction(() => {
    ledger.createAgent(agent);
    ledger.setSatietyAnchor(name, values.initialSatiety, now);
    ledger.appendBalanceEvent(name, values.initialBalance, 'genesis', null, now);
  });
  return { ok: true, agent };
}

/** Which agents are mid-round right now. In memory only: a restart clears it. */
export class RoundRegistry {
  private readonly busy = new Set<string>();

  markStarted(name: string): void {
    this.busy.add(name);
  }

  markEnded(name: string): void {
    this.busy.delete(name);
  }

  isBusy(name: string): boolean {
    return this.busy.has(name);
  }

  busyAgents(): string[] {
    return [...this.busy].sort();
  }
}

export interface WakeReport {
  woken: string[];
  skipped: string[];
  /** How many living agents were left alone, and why. */
  reasons: { agent: string; reason: 'busy' | 'paused' }[];
}

/**
 * Wakes every living agent that is not already in a round. The heartbeat and
 * the console's "wake up now" both go through this, so they obey one rule.
 *
 * A paused conservatory wakes nobody: while the operator has stopped time, the
 * heartbeat must not start a round for anyone. The console's explicit
 * "wake up now" still can, which is what makes debugging a paused conservatory
 * possible.
 */
export function wakeLivingAgents(deps: {
  ledger: Ledger;
  registry: RoundRegistry;
  paused?: boolean;
  wake(agent: AgentRecord): void;
}): WakeReport {
  const report: WakeReport = { woken: [], skipped: [], reasons: [] };
  for (const agent of deps.ledger.listAgents()) {
    if (agent.status !== 'alive') {
      continue;
    }
    if (deps.paused === true) {
      report.skipped.push(agent.name);
      report.reasons.push({ agent: agent.name, reason: 'paused' });
      continue;
    }
    if (deps.registry.isBusy(agent.name)) {
      report.skipped.push(agent.name);
      report.reasons.push({ agent: agent.name, reason: 'busy' });
      continue;
    }
    report.woken.push(agent.name);
    deps.wake(agent);
  }
  return report;
}
