import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { readSandboxPolicy, type SandboxPolicyConfig } from './organs/sandbox/policy';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Every tunable number of the body. Read from conservatory.config.json. */
export interface ConservatoryValues {
  satietyDecayPerSecond: number;
  satietyMax: number;
  initialSatiety: number;
  initialBalance: number;
  mealPrice: number;
  satietyPerMeal: number;
  heartbeatSeconds: number;
  maxSlots: number;
  memoryCapChars: number;
  roundContextCapTokens: number;
  /** The most tool calls one round may make before it is ended by force. */
  maxToolCallsPerRound: number;
  /** How long one model request may take before it is given up on. */
  modelRequestTimeoutSeconds: number;
  taskClaimTimeoutHours: number;
  /** How often a starving agent loses characters from MEMORY. */
  redactionIntervalSeconds: number;
  /** How many characters one redaction tick takes. */
  redactionCharsPerTick: number;
  /** How many separate wounds one redaction tick may open. */
  redactionMinRanges: number;
  redactionMaxRanges: number;
  /** Untreated redacted characters at or above this count kill the agent. */
  deathLineChars: number;
  ordinaryTreatmentPrice: number;
  completeTreatmentPrice: number;
  /** null means "not set": crediting outside income must then be refused. */
  exchangeRate: number | null;
  consolePort: number;
}

/**
 * How hard the model is asked to think before answering. The three levels every
 * OpenAI-compatible endpoint agrees on; a provider that does not support the
 * parameter simply ignores it.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high';
}

export interface ModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Absent means "let the provider decide". It is left off rather than set to
   * `undefined`, so a settings object built from a default still compares equal
   * to one written before this field existed.
   */
  reasoningEffort?: ReasoningEffort;
}

export interface ModelsConfig {
  agent: ModelSettings;
  memory: ModelSettings;
}

export interface RuntimePaths {
  rootDir: string;
  configPath: string;
  envPath: string;
  agentsDir: string;
  supervisorDir: string;
  ledgerPath: string;
  blackboxDir: string;
  /** The editable prompt templates. They are source, not runtime state. */
  promptsDir: string;
}

export interface AppConfig {
  values: ConservatoryValues;
  models: ModelsConfig;
  paths: RuntimePaths;
  /** The command sandbox's policy, as the console can edit it. */
  sandbox: SandboxPolicyConfig;
}

export interface LoadAppConfigOptions {
  rootDir?: string;
  /** When given, these are used instead of reading .env from disk. */
  env?: Record<string, string | undefined>;
  envFile?: string;
  configFile?: string;
}

export const CONFIG_FILE_NAME = 'conservatory.config.json';
export const ENV_FILE_NAME = '.env';
export const PROMPTS_DIR_NAME = 'prompts';

const ENV_KEYS = [
  'AGENT_MODEL_BASE_URL',
  'AGENT_MODEL_API_KEY',
  'AGENT_MODEL_NAME',
  'MEMORY_MODEL_BASE_URL',
  'MEMORY_MODEL_API_KEY',
  'MEMORY_MODEL_NAME',
] as const;

function readProcessEnv(envPath: string): Record<string, string | undefined> {
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
  return process.env;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readConfigFileObject(configPath: string, errors: string[]): Record<string, unknown> {
  if (!existsSync(configPath)) {
    errors.push(`config file not found: ${configPath}`);
    return {};
  }
  const text = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`config file ${configPath} is not valid JSON: ${detail}`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push(`config file ${configPath} must contain a JSON object`);
    return {};
  }
  return asRecord(parsed);
}

interface NumberRule {
  integer?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
}

function readNumberField(
  source: Record<string, unknown>,
  key: string,
  rule: NumberRule,
  errors: string[],
): number {
  const raw = source[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    errors.push(`"${key}" is missing or not a finite number`);
    return 0;
  }
  if (rule.integer === true && !Number.isInteger(raw)) {
    errors.push(`"${key}" must be an integer`);
  }
  if (rule.exclusiveMin === true) {
    if (rule.min !== undefined && raw <= rule.min) {
      errors.push(`"${key}" must be greater than ${rule.min}`);
    }
  } else if (rule.min !== undefined && raw < rule.min) {
    errors.push(`"${key}" must be at least ${rule.min}`);
  }
  if (rule.max !== undefined && raw > rule.max) {
    errors.push(`"${key}" must be at most ${rule.max}`);
  }
  return raw;
}

function readExchangeRate(source: Record<string, unknown>, errors: string[]): number | null {
  const raw = source['exchangeRate'];
  if (raw === null) {
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  errors.push('"exchangeRate" must be null or a number greater than 0');
  return null;
}

function readValues(source: Record<string, unknown>, errors: string[]): ConservatoryValues {
  const values: ConservatoryValues = {
    satietyDecayPerSecond: readNumberField(source, 'satietyDecayPerSecond', { min: 0, exclusiveMin: true }, errors),
    satietyMax: readNumberField(source, 'satietyMax', { min: 0, exclusiveMin: true }, errors),
    initialSatiety: readNumberField(source, 'initialSatiety', { min: 0 }, errors),
    initialBalance: readNumberField(source, 'initialBalance', { min: 0 }, errors),
    mealPrice: readNumberField(source, 'mealPrice', { min: 0 }, errors),
    satietyPerMeal: readNumberField(source, 'satietyPerMeal', { min: 0, exclusiveMin: true }, errors),
    heartbeatSeconds: readNumberField(source, 'heartbeatSeconds', { min: 0, exclusiveMin: true }, errors),
    maxSlots: readNumberField(source, 'maxSlots', { integer: true, min: 1 }, errors),
    memoryCapChars: readNumberField(source, 'memoryCapChars', { integer: true, min: 1 }, errors),
    roundContextCapTokens: readNumberField(source, 'roundContextCapTokens', { integer: true, min: 1 }, errors),
    maxToolCallsPerRound: readNumberField(source, 'maxToolCallsPerRound', { integer: true, min: 1 }, errors),
    modelRequestTimeoutSeconds: readNumberField(
      source,
      'modelRequestTimeoutSeconds',
      { min: 0, exclusiveMin: true },
      errors,
    ),
    taskClaimTimeoutHours: readNumberField(source, 'taskClaimTimeoutHours', { min: 0, exclusiveMin: true }, errors),
    redactionIntervalSeconds: readNumberField(
      source,
      'redactionIntervalSeconds',
      { min: 0, exclusiveMin: true },
      errors,
    ),
    redactionCharsPerTick: readNumberField(source, 'redactionCharsPerTick', { integer: true, min: 1 }, errors),
    redactionMinRanges: readNumberField(source, 'redactionMinRanges', { integer: true, min: 1 }, errors),
    redactionMaxRanges: readNumberField(source, 'redactionMaxRanges', { integer: true, min: 1 }, errors),
    deathLineChars: readNumberField(source, 'deathLineChars', { integer: true, min: 1 }, errors),
    ordinaryTreatmentPrice: readNumberField(source, 'ordinaryTreatmentPrice', { min: 0 }, errors),
    completeTreatmentPrice: readNumberField(source, 'completeTreatmentPrice', { min: 0 }, errors),
    exchangeRate: readExchangeRate(source, errors),
    consolePort: readNumberField(source, 'consolePort', { integer: true, min: 1, max: 65535 }, errors),
  };
  if (values.initialSatiety > values.satietyMax) {
    errors.push('"initialSatiety" must not exceed "satietyMax"');
  }
  // One wound can never be asked to take more characters than a tick takes.
  if (values.redactionMaxRanges < values.redactionMinRanges) {
    errors.push('"redactionMaxRanges" must be at least "redactionMinRanges"');
  }
  if (values.redactionMaxRanges > values.redactionCharsPerTick) {
    errors.push('"redactionMaxRanges" must not exceed "redactionCharsPerTick"');
  }
  // The death line has to be reachable: MEMORY must hold far more than it takes
  // to die, or no agent could ever be redacted to death.
  if (values.memoryCapChars <= values.deathLineChars) {
    errors.push('"memoryCapChars" must be greater than "deathLineChars"');
  }
  // A full MEMORY has to fit in one round's budget, with room for the tool
  // round trips that round will make. About four characters per token, so
  // memoryCapChars / 4 is the memory's token count; without the headroom a
  // grown MEMORY would exceed the cap every round and the agent could never
  // wake up again.
  const memoryTokens = Math.ceil(values.memoryCapChars / 4);
  const minimumContextTokens = memoryTokens + 150000;
  if (values.roundContextCapTokens < minimumContextTokens) {
    errors.push(
      `"roundContextCapTokens" must be at least ${minimumContextTokens} (ceil("memoryCapChars" / 4) + 150000)`,
    );
  }
  return values;
}

/**
 * The tunable numbers the operator may edit from the console, each with the
 * rule it must satisfy. This is the same table `readValues` applies, kept as
 * data so a partial update and a whole-file read can never disagree about what
 * a legal number is. `exchangeRate` is absent on purpose: it is the one field
 * that may also be `null`, so it is validated on its own below.
 */
const TUNABLE_NUMBER_RULES: readonly (readonly [string, NumberRule])[] = [
  ['satietyDecayPerSecond', { min: 0, exclusiveMin: true }],
  ['satietyMax', { min: 0, exclusiveMin: true }],
  ['initialSatiety', { min: 0 }],
  ['initialBalance', { min: 0 }],
  ['mealPrice', { min: 0 }],
  ['satietyPerMeal', { min: 0, exclusiveMin: true }],
  ['heartbeatSeconds', { min: 0, exclusiveMin: true }],
  ['maxSlots', { integer: true, min: 1 }],
  ['memoryCapChars', { integer: true, min: 1 }],
  ['roundContextCapTokens', { integer: true, min: 1 }],
  ['maxToolCallsPerRound', { integer: true, min: 1 }],
  ['modelRequestTimeoutSeconds', { min: 0, exclusiveMin: true }],
  ['taskClaimTimeoutHours', { min: 0, exclusiveMin: true }],
  ['redactionIntervalSeconds', { min: 0, exclusiveMin: true }],
  ['redactionCharsPerTick', { integer: true, min: 1 }],
  ['redactionMinRanges', { integer: true, min: 1 }],
  ['redactionMaxRanges', { integer: true, min: 1 }],
  ['deathLineChars', { integer: true, min: 1 }],
  ['ordinaryTreatmentPrice', { min: 0 }],
  ['completeTreatmentPrice', { min: 0 }],
  // The port can be stored, but the listener is bound once at boot; the console
  // says so rather than pretending the change is live.
  ['consolePort', { integer: true, min: 1, max: 65535 }],
];

const EXCHANGE_RATE_KEY = 'exchangeRate';
const TUNABLE_KEYS: readonly string[] = [
  ...TUNABLE_NUMBER_RULES.map(([key]) => key),
  EXCHANGE_RATE_KEY,
];
const TUNABLE_RULE_BY_KEY = new Map<string, NumberRule>(TUNABLE_NUMBER_RULES);

/** One field's value, described in the operator's own language. */
function describeNumberProblem(key: string, rule: NumberRule): string {
  if (rule.integer === true) {
    return `「${key}」必须是整数`;
  }
  if (rule.exclusiveMin === true) {
    return `「${key}」必须是大于 ${rule.min ?? 0} 的数字`;
  }
  if (rule.min !== undefined) {
    return `「${key}」不能小于 ${rule.min}`;
  }
  if (rule.max !== undefined) {
    return `「${key}」不能大于 ${rule.max}`;
  }
  return `「${key}」必须是数字`;
}

/** The rule check for one field, returning a Chinese reason or null. */
function checkTunableNumber(key: string, raw: unknown, rule: NumberRule): string | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return `「${key}」必须是数字`;
  }
  if (rule.integer === true && !Number.isInteger(raw)) {
    return `「${key}」必须是整数`;
  }
  if (rule.exclusiveMin === true) {
    if (rule.min !== undefined && raw <= rule.min) {
      return `「${key}」必须是大于 ${rule.min} 的数字`;
    }
  } else if (rule.min !== undefined && raw < rule.min) {
    return `「${key}」不能小于 ${rule.min}`;
  }
  if (rule.max !== undefined && raw > rule.max) {
    return `「${key}」不能大于 ${rule.max}`;
  }
  return null;
}

function checkExchangeRate(raw: unknown): string | null {
  if (raw === null) {
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return null;
  }
  return '「exchangeRate」必须是 null（未设定）或大于 0 的数字';
}

export type ValuesPatchResult =
  | { ok: true; next: ConservatoryValues; changedKeys: (keyof ConservatoryValues)[] }
  | { ok: false; error: string };

/**
 * A partial update of the body's numbers, checked with the same rules the whole
 * file is read with, and then checked again as a whole.
 *
 * The cross-field rules are the reason this cannot be a per-field check: they
 * only make sense against the merged result. Two of them are special-cased.
 * `memoryCapChars`/`roundContextCapTokens` are only re-checked when the patch
 * touches one of them, because a config that is already live may predate the
 * rule and an unrelated edit must not be refused for it. Everything else is
 * always enforced, since a patch that leaves those numbers alone cannot have
 * broken them.
 */
export function validateValuesPatch(current: ConservatoryValues, patch: unknown): ValuesPatchResult {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: '参数格式不合法' };
  }
  const source = patch as Record<string, unknown>;
  const ownKeys = Object.keys(source);
  if (ownKeys.length === 0) {
    return { ok: false, error: '参数格式不合法' };
  }
  const recognised = ownKeys.filter((key) => TUNABLE_KEYS.includes(key));
  if (recognised.length === 0) {
    return { ok: false, error: '没有需要更新的参数字段' };
  }

  const next: ConservatoryValues = { ...current };
  // Walked in the table's order rather than the request's, so the same two bad
  // fields always produce the same first complaint.
  for (const key of TUNABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const raw = source[key];
    if (key === EXCHANGE_RATE_KEY) {
      const problem = checkExchangeRate(raw);
      if (problem !== null) {
        return { ok: false, error: problem };
      }
      next.exchangeRate = raw === null ? null : (raw as number);
      continue;
    }
    const rule = TUNABLE_RULE_BY_KEY.get(key);
    if (rule === undefined) {
      continue;
    }
    const problem = checkTunableNumber(key, raw, rule);
    if (problem !== null) {
      return { ok: false, error: problem };
    }
    (next as unknown as Record<string, unknown>)[key] = raw;
  }

  const touched = (key: string): boolean => Object.prototype.hasOwnProperty.call(source, key);
  if (next.initialSatiety > next.satietyMax) {
    return { ok: false, error: '出生饱食度（initialSatiety）不能超过饱食度上限（satietyMax）' };
  }
  if (next.redactionMaxRanges < next.redactionMinRanges) {
    return { ok: false, error: '单次最多伤口数（redactionMaxRanges）不能小于最少伤口数（redactionMinRanges）' };
  }
  if (next.redactionMaxRanges > next.redactionCharsPerTick) {
    return { ok: false, error: '单次最多伤口数（redactionMaxRanges）不能超过每次遮盖字数（redactionCharsPerTick）' };
  }
  if (next.memoryCapChars <= next.deathLineChars) {
    return { ok: false, error: 'MEMORY 上限（memoryCapChars）必须大于死亡线（deathLineChars）' };
  }
  if (touched('memoryCapChars') || touched('roundContextCapTokens')) {
    const minimumContextTokens = Math.ceil(next.memoryCapChars / 4) + 150000;
    if (next.roundContextCapTokens < minimumContextTokens) {
      return {
        ok: false,
        error: `一轮上下文上限（roundContextCapTokens）不能小于 ${minimumContextTokens}（MEMORY 上限 ÷ 4 向上取整 + 150000）`,
      };
    }
  }

  const changedKeys = TUNABLE_KEYS.filter(
    (key) => next[key as keyof ConservatoryValues] !== current[key as keyof ConservatoryValues],
  ) as (keyof ConservatoryValues)[];
  return { ok: true, next, changedKeys };
}

/**
 * Writes the body's numbers back into the config file, keeping every other
 * top-level key (the sandbox policy, and anything an operator added by hand)
 * exactly as it was.
 *
 * `ConservatoryValues` holds no secret — it is all numbers plus the exchange
 * rate — so nothing here can put an API key into a tracked file. The model
 * roster lives in its own gitignored file and is never read or written here.
 */
export function persistConservatoryValues(configPath: string, values: ConservatoryValues): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`config file ${configPath} must contain a JSON object`);
    }
    existing = { ...(parsed as Record<string, unknown>) };
  }
  const next: Record<string, unknown> = { ...existing, ...values };
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function readEnvString(env: Record<string, string | undefined>, key: string, errors: string[]): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${key} is missing or empty (copy .env.example to .env and fill it in)`);
    return '';
  }
  return value.trim();
}

function readModels(env: Record<string, string | undefined>, errors: string[]): ModelsConfig {
  return {
    agent: {
      baseUrl: readEnvString(env, 'AGENT_MODEL_BASE_URL', errors),
      apiKey: readEnvString(env, 'AGENT_MODEL_API_KEY', errors),
      model: readEnvString(env, 'AGENT_MODEL_NAME', errors),
    },
    memory: {
      baseUrl: readEnvString(env, 'MEMORY_MODEL_BASE_URL', errors),
      apiKey: readEnvString(env, 'MEMORY_MODEL_API_KEY', errors),
      model: readEnvString(env, 'MEMORY_MODEL_NAME', errors),
    },
  };
}

export function createRuntimePaths(rootDir: string, configPath: string, envPath: string): RuntimePaths {
  const resolvedRoot = path.resolve(rootDir);
  const supervisorDir = path.join(resolvedRoot, 'SUPERVISOR');
  return {
    rootDir: resolvedRoot,
    configPath,
    envPath,
    agentsDir: path.join(resolvedRoot, 'AGENTS'),
    supervisorDir,
    ledgerPath: path.join(supervisorDir, 'ledger.db'),
    blackboxDir: path.join(supervisorDir, 'blackbox'),
    promptsDir: path.join(resolvedRoot, PROMPTS_DIR_NAME),
  };
}

/**
 * Reads conservatory.config.json and the model environment. Any missing or
 * ill-typed item is collected and thrown as one ConfigError so the caller can
 * report every problem at once instead of one per restart.
 */
export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const configPath = options.configFile ?? path.join(rootDir, CONFIG_FILE_NAME);
  const envPath = options.envFile ?? path.join(rootDir, ENV_FILE_NAME);
  const env = options.env ?? readProcessEnv(envPath);
  const errors: string[] = [];
  const source = readConfigFileObject(configPath, errors);
  const values = readValues(source, errors);
  const sandbox = readSandboxPolicy(source, errors);
  const models = readModels(env, errors);
  if (errors.length > 0) {
    throw new ConfigError(`configuration problems:\n- ${errors.join('\n- ')}`);
  }
  return { values, models, paths: createRuntimePaths(rootDir, configPath, envPath), sandbox };
}

export function ensureRuntimeDirs(paths: RuntimePaths): void {
  mkdirSync(paths.agentsDir, { recursive: true });
  mkdirSync(paths.supervisorDir, { recursive: true });
  mkdirSync(paths.blackboxDir, { recursive: true });
}

export function agentHomeDir(paths: RuntimePaths, name: string): string {
  return path.join(paths.agentsDir, name);
}

export function agentMemoryPath(paths: RuntimePaths, name: string): string {
  return path.join(agentHomeDir(paths, name), 'MEMORY');
}

export function agentNotebookDir(paths: RuntimePaths, name: string): string {
  return path.join(agentHomeDir(paths, name), 'notebook');
}

export { ENV_KEYS };
