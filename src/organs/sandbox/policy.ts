/**
 * The sandbox policy: what an agent's command may read and write, as the
 * operator configures it in the console, plus the built-in entries that no
 * operator edit can remove.
 *
 * Two layers are kept apart on purpose.
 *
 *  - The **configured** policy is what lives in `conservatory.config.json`
 *    under `"sandbox"` and what the console edits. It is global and survives
 *    restarts.
 *  - The **resolved** policy is what one command actually runs with. It adds
 *    the entries that follow from the body rather than from operator taste:
 *    `SUPERVISOR/` (the ledger and the black boxes) and every other agent's
 *    home are always unreadable, the running agent's own notebook is always
 *    writable, and its `MEMORY` is always read-only. Those are shown to the
 *    operator as locked rows.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The operator-editable half of the sandbox policy. */
export interface SandboxPolicyConfig {
  readMode: 'blacklist' | 'whitelist';
  readBlacklist: string[];
  readWhitelist: string[];
  writableDirs: string[];
  commandTimeoutSeconds: number;
  maxOutputChars: number;
}

/** What the console shows: the configured policy plus the locked rows. */
export interface SandboxPolicyView extends SandboxPolicyConfig {
  /** Built-in blacklist entries the operator may see but never delete. */
  lockedReadBlacklist: string[];
  /** Built-in writable entries the operator may see but never delete. */
  lockedWritableDirs: string[];
  /** Absolute path of the file the policy is persisted to. */
  configPath: string;
}

/** One agent's identity, as the resolver needs it. */
export interface SandboxAgentIdentity {
  name: string;
  homeDir: string;
  notebookDir: string;
  memoryPath: string;
}

/** The policy one command actually runs with. */
export interface ResolvedSandboxPolicy {
  readMode: 'blacklist' | 'whitelist';
  readBlacklist: string[];
  readWhitelist: string[];
  writableDirs: string[];
  commandTimeoutSeconds: number;
  maxOutputChars: number;
  /** Always-denied paths, whatever the operator configured. */
  lockedReadBlacklist: string[];
  /** Always-writable paths, whatever the operator configured. */
  lockedWritableDirs: string[];
  /** Read-only files (the agent's MEMORY). */
  readOnlyFiles: string[];
  /** Root inside which whitelist mode denies everything not listed. */
  whitelistRoot: string;
}

export interface SandboxPolicyStore {
  view(): SandboxPolicyView;
  current(): SandboxPolicyConfig;
  update(payload: unknown): { ok: true; view: SandboxPolicyView } | { ok: false; error: string };
  resolve(agent: SandboxAgentIdentity): ResolvedSandboxPolicy;
}

export interface SandboxPolicyStoreOptions {
  /** Absolute path of conservatory.config.json. */
  configPath: string;
  /** The directory the agent territory (and whitelist mode) is rooted at. */
  agentsDir: string;
  /** The directory holding the ledger and the black boxes. */
  supervisorDir: string;
  /** Every agent home currently known, including dead agents. */
  listAgentHomes(): string[];
  /** The policy read from the config file at startup. */
  initial: SandboxPolicyConfig;
  /** Overrides persistence (tests). Throws on failure. */
  persist?(config: SandboxPolicyConfig): void;
}

/** Every field at its documented default. */
export const DEFAULT_SANDBOX_POLICY: SandboxPolicyConfig = {
  readMode: 'blacklist',
  readBlacklist: [],
  readWhitelist: [],
  writableDirs: [],
  commandTimeoutSeconds: 60,
  maxOutputChars: 20_000,
};

const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_OUTPUT_CHARS = 1_000_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readPathList(source: Record<string, unknown>, key: string, errors: string[]): string[] {
  const raw = source[key];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
    errors.push(`"sandbox.${key}" must be an array of non-empty strings`);
    return [];
  }
  return (raw as string[]).map((entry) => entry.trim());
}

/**
 * Read the `"sandbox"` block out of an already-parsed config object. A missing
 * block means "all defaults", so a config file written before this step keeps
 * working; a present but ill-typed field is an error like any other field.
 */
export function readSandboxPolicy(source: Record<string, unknown>, errors: string[]): SandboxPolicyConfig {
  const rawBlock = source['sandbox'];
  const block = rawBlock === undefined ? {} : asRecord(rawBlock);
  if (block === null) {
    errors.push('"sandbox" must be a JSON object');
    return { ...DEFAULT_SANDBOX_POLICY };
  }
  const sandbox = block;
  const readMode = sandbox['readMode'];
  if (readMode !== undefined && readMode !== 'blacklist' && readMode !== 'whitelist') {
    errors.push('"sandbox.readMode" must be "blacklist" or "whitelist"');
  }
  return {
    readMode: readMode === 'whitelist' ? 'whitelist' : 'blacklist',
    readBlacklist: readPathList(sandbox, 'readBlacklist', errors),
    readWhitelist: readPathList(sandbox, 'readWhitelist', errors),
    writableDirs: readPathList(sandbox, 'writableDirs', errors),
    commandTimeoutSeconds: readSandboxNumber(
      sandbox,
      'commandTimeoutSeconds',
      DEFAULT_SANDBOX_POLICY.commandTimeoutSeconds,
      MAX_TIMEOUT_SECONDS,
      errors,
    ),
    maxOutputChars: readSandboxNumber(
      sandbox,
      'maxOutputChars',
      DEFAULT_SANDBOX_POLICY.maxOutputChars,
      MAX_OUTPUT_CHARS,
      errors,
    ),
  };
}

function readSandboxNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
  errors: string[],
): number {
  const raw = source[key];
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > max) {
    errors.push(`"sandbox.${key}" must be a number greater than 0 and at most ${max}`);
    return fallback;
  }
  return raw;
}

type PatchResult = { ok: true; value: Partial<SandboxPolicyConfig> } | { ok: false; error: string };

/** Validate a console payload; every field is optional. */
export function validateSandboxPatch(payload: unknown): PatchResult {
  const body = asRecord(payload);
  if (body === null) {
    return { ok: false, error: 'invalid_path_list' };
  }
  const value: Partial<SandboxPolicyConfig> = {};
  let recognised = 0;

  if (body['readMode'] !== undefined) {
    recognised += 1;
    if (body['readMode'] !== 'blacklist' && body['readMode'] !== 'whitelist') {
      return { ok: false, error: 'invalid_read_mode' };
    }
    value.readMode = body['readMode'];
  }

  for (const key of ['readBlacklist', 'readWhitelist', 'writableDirs'] as const) {
    if (body[key] === undefined) {
      continue;
    }
    recognised += 1;
    const parsed = validatePathList(body[key]);
    if (parsed === null) {
      return { ok: false, error: 'invalid_path_list' };
    }
    value[key] = parsed;
  }

  if (body['commandTimeoutSeconds'] !== undefined) {
    recognised += 1;
    const raw = body['commandTimeoutSeconds'];
    if (
      typeof raw !== 'number' ||
      !Number.isFinite(raw) ||
      raw <= 0 ||
      raw > MAX_TIMEOUT_SECONDS
    ) {
      return { ok: false, error: 'invalid_command_timeout' };
    }
    value.commandTimeoutSeconds = raw;
  }

  if (body['maxOutputChars'] !== undefined) {
    recognised += 1;
    const raw = body['maxOutputChars'];
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw <= 0 ||
      raw > MAX_OUTPUT_CHARS
    ) {
      return { ok: false, error: 'invalid_max_output' };
    }
    value.maxOutputChars = raw;
  }

  if (recognised === 0) {
    return { ok: false, error: 'empty_sandbox_patch' };
  }
  return { ok: true, value };
}

function validatePathList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return null;
    }
    const trimmed = entry.trim();
    if (trimmed === '' || !path.isAbsolute(trimmed)) {
      return null;
    }
    const resolved = path.resolve(trimmed);
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/** Write the sandbox block back into the config file, preserving every other key. */
export function persistSandboxPolicy(configPath: string, policy: SandboxPolicyConfig): void {
  const text = readFileSync(configPath, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config file ${configPath} must contain a JSON object`);
  }
  const next = { ...(parsed as Record<string, unknown>), sandbox: policy };
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function uniqueAbsolute(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/** True when `inner` is `outer` or lives inside it. */
function isSameOrInside(inner: string, outer: string): boolean {
  const innerKey = path.resolve(inner).toLowerCase();
  const outerKey = path.resolve(outer).toLowerCase().replace(/[\\/]+$/, '');
  return innerKey === outerKey || innerKey.startsWith(`${outerKey}${path.sep}`);
}

export function createSandboxPolicyStore(options: SandboxPolicyStoreOptions): SandboxPolicyStore {
  let policy: SandboxPolicyConfig = { ...options.initial };
  const persist =
    options.persist ?? ((next: SandboxPolicyConfig): void => persistSandboxPolicy(options.configPath, next));

  const lockedBlacklist = (excludeAgent: string | null): string[] => {
    const homes = options.listAgentHomes().filter((home) => excludeAgent === null || path.basename(home) !== excludeAgent);
    return uniqueAbsolute([options.supervisorDir, ...homes]);
  };

  const lockedWritable = (onlyAgent: string | null): string[] => {
    const homes = options.listAgentHomes().filter((home) => onlyAgent === null || path.basename(home) === onlyAgent);
    return uniqueAbsolute(homes.map((home) => path.join(home, 'notebook')));
  };

  const view = (): SandboxPolicyView => ({
    ...policy,
    readBlacklist: [...policy.readBlacklist],
    readWhitelist: [...policy.readWhitelist],
    writableDirs: [...policy.writableDirs],
    lockedReadBlacklist: lockedBlacklist(null),
    lockedWritableDirs: lockedWritable(null),
    configPath: options.configPath,
  });

  return {
    view,
    current: () => ({ ...policy }),
    update: (payload: unknown) => {
      const parsed = validateSandboxPatch(payload);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }
      const next: SandboxPolicyConfig = { ...policy, ...parsed.value };
      try {
        persist(next);
      } catch {
        return { ok: false, error: 'sandbox_config_write_failed' };
      }
      policy = next;
      return { ok: true, view: view() };
    },
    resolve: (agent: SandboxAgentIdentity): ResolvedSandboxPolicy => {
      const locked = lockedBlacklist(agent.name);
      const lockedWritableDirs = [path.resolve(agent.notebookDir)];
      // The configured blacklist loses any entry that would sit on the agent's
      // own body: the notebook it must write, or its home and MEMORY it must
      // still read.
      const configuredBlacklist = policy.readBlacklist.filter(
        (entry) =>
          !isSameOrInside(agent.homeDir, entry) &&
          !isSameOrInside(agent.notebookDir, entry) &&
          !isSameOrInside(agent.memoryPath, entry),
      );
      const readBlacklist = uniqueAbsolute([...locked, ...configuredBlacklist]);
      const writableDirs = uniqueAbsolute([...lockedWritableDirs, ...policy.writableDirs]);
      const readWhitelist = uniqueAbsolute([
        agent.homeDir,
        agent.notebookDir,
        ...policy.readWhitelist,
      ]);
      return {
        readMode: policy.readMode,
        readBlacklist,
        readWhitelist,
        writableDirs,
        commandTimeoutSeconds: policy.commandTimeoutSeconds,
        maxOutputChars: policy.maxOutputChars,
        lockedReadBlacklist: locked,
        lockedWritableDirs,
        readOnlyFiles: [path.resolve(agent.memoryPath)],
        whitelistRoot: path.resolve(options.agentsDir),
      };
    },
  };
}
