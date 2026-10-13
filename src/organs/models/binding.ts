/**
 * The model binding: which provider and which model one agent's brain runs on.
 *
 * It is frozen into a file inside the agent's own home at birth, and the agent
 * keeps that binding for life unless the operator switches it. Editing the
 * global roster afterwards therefore cannot silently change the brain of an
 * agent that is already alive — a frozen copy is the whole point.
 *
 * The snapshot is deliberately complete, API key included: an agent keeps
 * running even if its provider is later deleted from the roster.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { agentHomeDir, isReasoningEffort, type ReasoningEffort, type RuntimePaths } from '../../config';

export const MODEL_BINDING_FILE = 'MODEL.json';

/** The frozen snapshot of one agent's brain, as stored in its home. */
export interface AgentModelBinding {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** How hard this brain is asked to think; absent means the provider decides. */
  reasoningEffort?: ReasoningEffort;
  /** When the operator last bound or switched this brain. */
  boundAt: number;
}

export function modelBindingPath(paths: RuntimePaths, name: string): string {
  return path.join(agentHomeDir(paths, name), MODEL_BINDING_FILE);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Reads the binding back. A file that is missing, unreadable, torn or
 * ill-typed returns null, so the caller falls back to the ledger and the
 * environment rather than refusing to wake an agent.
 */
export function readModelBinding(paths: RuntimePaths, name: string): AgentModelBinding | null {
  const file = modelBindingPath(paths, name);
  if (!existsSync(file)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) {
    return null;
  }
  const providerId = readString(record, 'providerId');
  const baseUrl = readString(record, 'baseUrl');
  const apiKey = readString(record, 'apiKey');
  const model = readString(record, 'model');
  if (providerId === null || baseUrl === null || apiKey === null || model === null) {
    return null;
  }
  const providerName = readString(record, 'providerName');
  const boundAt = record['boundAt'];
  // A level that is not one of the three is a torn or hand-edited file: the
  // binding is then simply absent of a level, never given a bogus one.
  const effort = record['reasoningEffort'];
  return {
    providerId,
    providerName: providerName ?? providerId,
    baseUrl,
    apiKey,
    model,
    ...(isReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
    boundAt: typeof boundAt === 'number' && Number.isFinite(boundAt) ? boundAt : 0,
  };
}

/** Temp file plus rename, so a wake-up never reads a half-written binding. */
export function writeModelBinding(paths: RuntimePaths, name: string, binding: AgentModelBinding): void {
  mkdirSync(agentHomeDir(paths, name), { recursive: true });
  const target = modelBindingPath(paths, name);
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
  renameSync(temp, target);
}
