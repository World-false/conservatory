/**
 * The model roster: which providers and models the operator has configured, and
 * which of them are the defaults for a new agent and for the memory system.
 *
 * Two layers, because that is how an operator thinks about a brain:
 *
 *  - A **provider** is one OpenAI-compatible endpoint — a base URL, a key, and
 *    the list of model names that endpoint serves.
 *  - A **model** is one name under a provider. Choosing a brain is choosing a
 *    provider and then a model inside it.
 *
 * The roster lives in its own file, `conservatory.models.json`, beside the
 * config file and **not** inside it. A provider entry carries an API key, and
 * `conservatory.config.json` is tracked by git — the same reason `.env` is
 * gitignored applies here, so the roster file is gitignored too. The config
 * file keeps no secrets at all.
 *
 * A deployment that has never opened the model panel has no roster file. The
 * first read then seeds the roster from the `AGENT_MODEL_*` / `MEMORY_MODEL_*`
 * environment variables and writes it back, so an existing install keeps
 * working unchanged.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isReasoningEffort, type ModelSettings, type ReasoningEffort } from '../../config';

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** The model names this endpoint serves. Never empty. */
  models: string[];
}

export interface ModelsConfigData {
  defaultAgentProviderId: string;
  defaultAgentModel: string;
  defaultAgentReasoningEffort?: ReasoningEffort;
  defaultMemoryProviderId: string;
  defaultMemoryModel: string;
  defaultMemoryReasoningEffort?: ReasoningEffort;
  providers: ModelProvider[];
}

/** A pair of provider and model, which is what "a brain" actually is. */
export interface ModelSelection {
  providerId: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export type ModelStorePatchResult =
  | { ok: true; data: ModelsConfigData }
  | { ok: false; error: string; agents?: string[] };

export interface ModelConfigStore {
  /** The roster as the console shows it: a detached copy, never the live object. */
  view(): ModelsConfigData;
  /** The roster as the rest of the harness reads it: also a detached copy. */
  current(): ModelsConfigData;
  update(patch: unknown): ModelStorePatchResult;
  getProvider(id: string): ModelProvider | null;
  /** The provider serving this model name, or null when none does. */
  providerOfModel(model: string): ModelProvider | null;
  /** The `{ baseUrl, apiKey, model }` one selection runs on, or null if unknown. */
  settingsFor(selection: ModelSelection): ModelSettings | null;
  /** The default brain for a new agent. */
  defaultAgentSelection(): ModelSelection;
  /** The default memory brain. */
  defaultMemorySelection(): ModelSelection;
  /** Absolute path of the file the roster is persisted to (holds keys, gitignored). */
  readonly modelsPath: string;
}

export interface ModelConfigStoreOptions {
  /** Absolute path of conservatory.config.json; the roster sits beside it. */
  configPath: string;
  /** The `.env`-derived models, used to seed the roster the first time only. */
  env: { agent: ModelSettings; memory: ModelSettings };
  /** Overrides how the persisted roster is read (tests). */
  readPersisted?(): ModelsConfigData | null;
  /** Overrides persistence (tests). Throws on failure. */
  persist?(data: ModelsConfigData): void;
  /**
   * Every living agent and the provider it is bound to. A provider that is
   * still in use cannot be deleted: an agent's brain is not a silent casualty
   * of tidying up a menu.
   */
  listBoundAgents?(): { agent: string; providerId: string }[];
}

const CONFIG_KEY = 'models';
export const MODELS_FILE_NAME = 'conservatory.models.json';
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const SEEDED_PROVIDER_ID = 'default';
export const SEEDED_PROVIDER_NAME = '默认提供商';

/** Where the roster lives, given the directory that holds the config file. */
export function modelsFilePath(configPath: string): string {
  return path.join(path.dirname(path.resolve(configPath)), MODELS_FILE_NAME);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Trims, drops empties, and removes duplicates while keeping the order. */
function normaliseModelList(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const name = nonEmptyString(entry);
    if (name === null || seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
  }
  return out;
}

function copyProvider(provider: ModelProvider): ModelProvider {
  return { ...provider, models: [...provider.models] };
}

function copyData(data: ModelsConfigData): ModelsConfigData {
  return { ...data, providers: data.providers.map(copyProvider) };
}

/**
 * Reads one optional reasoning-effort field. `undefined`, `null`, `''` and
 * `'default'` all mean "not chosen" and are reported as absent — the property
 * is then left off the object entirely, so a roster written before this field
 * existed still round-trips byte-for-byte. Anything else that is not one of the
 * three levels is a typo, and a typo must not be silently ignored.
 */
function readOptionalEffort(
  source: Record<string, unknown>,
  key: string,
): { ok: true; value: ReasoningEffort | undefined } | { ok: false } {
  const raw = source[key];
  if (raw === undefined || raw === null || raw === '' || raw === 'default') {
    return { ok: true, value: undefined };
  }
  if (isReasoningEffort(raw)) {
    return { ok: true, value: raw };
  }
  return { ok: false };
}

/**
 * Reads a `"models"` block off disk. Anything missing or ill-typed yields null,
 * which the caller treats as "not configured yet" and seeds from the
 * environment — a hand-edited file must not brick the console.
 */
function parseModelsBlock(raw: unknown): ModelsConfigData | null {
  const block = asRecord(raw);
  if (block === null) {
    return null;
  }
  const rawProviders = block['providers'];
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
    return null;
  }
  const providers: ModelProvider[] = [];
  for (const entry of rawProviders) {
    const record = asRecord(entry);
    if (record === null) {
      return null;
    }
    const id = nonEmptyString(record['id']);
    const name = nonEmptyString(record['name']);
    const baseUrl = nonEmptyString(record['baseUrl']);
    const apiKey = record['apiKey'];
    const rawModels = record['models'];
    if (
      id === null ||
      name === null ||
      baseUrl === null ||
      typeof apiKey !== 'string' ||
      !Array.isArray(rawModels)
    ) {
      return null;
    }
    const models = normaliseModelList(rawModels);
    if (models.length === 0) {
      return null;
    }
    providers.push({ id, name, baseUrl, apiKey, models });
  }
  const defaultAgentProviderId = nonEmptyString(block['defaultAgentProviderId']);
  const defaultAgentModel = nonEmptyString(block['defaultAgentModel']);
  const defaultMemoryProviderId = nonEmptyString(block['defaultMemoryProviderId']);
  const defaultMemoryModel = nonEmptyString(block['defaultMemoryModel']);
  if (
    defaultAgentProviderId === null ||
    defaultAgentModel === null ||
    defaultMemoryProviderId === null ||
    defaultMemoryModel === null
  ) {
    return null;
  }
  const agentEffort = readOptionalEffort(block, 'defaultAgentReasoningEffort');
  const memoryEffort = readOptionalEffort(block, 'defaultMemoryReasoningEffort');
  if (!agentEffort.ok || !memoryEffort.ok) {
    return null;
  }
  return {
    defaultAgentProviderId,
    defaultAgentModel,
    ...(agentEffort.value === undefined ? {} : { defaultAgentReasoningEffort: agentEffort.value }),
    defaultMemoryProviderId,
    defaultMemoryModel,
    ...(memoryEffort.value === undefined ? {} : { defaultMemoryReasoningEffort: memoryEffort.value }),
    providers,
  };
}

export function readModelsConfig(modelsPath: string): ModelsConfigData | null {
  if (!existsSync(modelsPath)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(modelsPath, 'utf8'));
  } catch {
    return null;
  }
  const file = asRecord(parsed);
  if (file === null) {
    return null;
  }
  // The block may sit at the top level of the roster file, or (for a file
  // written by hand in the older shape) nested under "models".
  return parseModelsBlock(file[CONFIG_KEY] === undefined ? file : file[CONFIG_KEY]);
}

/** Writes the roster file. It holds only this block, so it never needs merging. */
export function persistModelsConfig(modelsPath: string, data: ModelsConfigData): void {
  writeFileSync(modelsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

/**
 * The roster a config file written before this feature implies: one provider
 * carrying both the agent model and the memory model, and both defaults on it.
 * This is what makes the change invisible to an existing `.env`.
 */
export function seedFromEnv(env: { agent: ModelSettings; memory: ModelSettings }): ModelsConfigData {
  const models = normaliseModelList([env.agent.model, env.memory.model]);
  return {
    defaultAgentProviderId: SEEDED_PROVIDER_ID,
    defaultAgentModel: env.agent.model,
    defaultMemoryProviderId: SEEDED_PROVIDER_ID,
    defaultMemoryModel: env.memory.model,
    providers: [
      {
        id: SEEDED_PROVIDER_ID,
        name: SEEDED_PROVIDER_NAME,
        baseUrl: env.agent.baseUrl,
        apiKey: env.agent.apiKey,
        models: models.length === 0 ? [env.agent.model] : models,
      },
    ],
  };
}

interface ValidatedProviders {
  ok: true;
  providers: ModelProvider[];
}
interface InvalidProviders {
  ok: false;
  error: string;
}

function validateProviders(raw: unknown): ValidatedProviders | InvalidProviders {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'invalid_providers' };
  }
  if (raw.length === 0) {
    return { ok: false, error: 'no_providers' };
  }
  const providers: ModelProvider[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) {
      return { ok: false, error: 'invalid_provider' };
    }
    const id = nonEmptyString(record['id']);
    const name = nonEmptyString(record['name']);
    const baseUrl = nonEmptyString(record['baseUrl']);
    const apiKey = record['apiKey'];
    const rawModels = record['models'];
    if (id === null || !PROVIDER_ID_PATTERN.test(id)) {
      return { ok: false, error: 'invalid_provider_id' };
    }
    if (name === null || baseUrl === null) {
      return { ok: false, error: 'invalid_provider' };
    }
    if (typeof apiKey !== 'string') {
      return { ok: false, error: 'invalid_provider' };
    }
    if (!Array.isArray(rawModels)) {
      return { ok: false, error: 'invalid_provider_models' };
    }
    const models = normaliseModelList(rawModels);
    if (models.length === 0) {
      return { ok: false, error: 'empty_provider_models' };
    }
    if (seen.has(id)) {
      return { ok: false, error: 'duplicate_provider_id' };
    }
    seen.add(id);
    providers.push({ id, name, baseUrl, apiKey, models });
  }
  return { ok: true, providers };
}

function providerServes(providers: readonly ModelProvider[], providerId: string, model: string): boolean {
  const provider = providers.find((candidate) => candidate.id === providerId);
  return provider !== undefined && provider.models.includes(model);
}

export function createModelConfigStore(options: ModelConfigStoreOptions): ModelConfigStore {
  const modelsPath = modelsFilePath(options.configPath);
  const readPersisted = options.readPersisted ?? ((file: string) => readModelsConfig(file));
  const persist =
    options.persist ?? ((data: ModelsConfigData): void => persistModelsConfig(modelsPath, data));

  let data: ModelsConfigData;
  // The reader itself answers null for a missing or unreadable file, so there
  // is no existence check here to disagree with an injected one.
  const persisted = readPersisted(modelsPath);
  if (persisted === null) {
    // First run since this feature landed: seed from .env and write the roster
    // out, so the operator sees a working menu instead of an empty one.
    data = seedFromEnv(options.env);
    try {
      persist(data);
    } catch {
      // A read-only location must not stop the conservatory from starting; the
      // seeded roster stays live in memory for this run.
    }
  } else {
    data = persisted;
  }

  const view = (): ModelsConfigData => copyData(data);

  return {
    modelsPath,
    view,
    current: view,
    getProvider: (id: string) => {
      const found = data.providers.find((provider) => provider.id === id);
      return found === undefined ? null : copyProvider(found);
    },
    providerOfModel: (model: string) => {
      const found = data.providers.find((provider) => provider.models.includes(model));
      return found === undefined ? null : copyProvider(found);
    },
    settingsFor: (selection: ModelSelection) => {
      const provider = data.providers.find((candidate) => candidate.id === selection.providerId);
      if (provider === undefined || !provider.models.includes(selection.model)) {
        return null;
      }
      return {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: selection.model,
        ...(isReasoningEffort(selection.reasoningEffort)
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      };
    },
    defaultAgentSelection: () => ({
      providerId: data.defaultAgentProviderId,
      model: data.defaultAgentModel,
      ...(data.defaultAgentReasoningEffort === undefined
        ? {}
        : { reasoningEffort: data.defaultAgentReasoningEffort }),
    }),
    defaultMemorySelection: () => ({
      providerId: data.defaultMemoryProviderId,
      model: data.defaultMemoryModel,
      ...(data.defaultMemoryReasoningEffort === undefined
        ? {}
        : { reasoningEffort: data.defaultMemoryReasoningEffort }),
    }),
    update: (patch: unknown): ModelStorePatchResult => {
      const body = asRecord(patch);
      if (body === null) {
        return { ok: false, error: 'invalid_models_patch' };
      }
      let recognised = 0;
      const next: ModelsConfigData = copyData(data);

      if (body['providers'] !== undefined) {
        recognised += 1;
        const validated = validateProviders(body['providers']);
        if (!validated.ok) {
          return { ok: false, error: validated.error };
        }
        // Deleting a provider a living agent still runs on would silently
        // change that agent's brain, so it is refused and the agent is named.
        const remaining = new Set(validated.providers.map((provider) => provider.id));
        const removed = data.providers.filter((provider) => !remaining.has(provider.id));
        if (removed.length > 0 && options.listBoundAgents !== undefined) {
          const removedIds = new Set(removed.map((provider) => provider.id));
          const blocked = options
            .listBoundAgents()
            .filter((binding) => removedIds.has(binding.providerId));
          if (blocked.length > 0) {
            return {
              ok: false,
              error: 'provider_in_use',
              agents: [...new Set(blocked.map((binding) => binding.agent))].sort(),
            };
          }
        }
        next.providers = validated.providers;
      }

      for (const key of [
        'defaultAgentProviderId',
        'defaultAgentModel',
        'defaultMemoryProviderId',
        'defaultMemoryModel',
      ] as const) {
        if (body[key] === undefined) {
          continue;
        }
        recognised += 1;
        const value = nonEmptyString(body[key]);
        if (value === null) {
          return { ok: false, error: 'invalid_models_patch' };
        }
        next[key] = value;
      }

      // The reasoning-effort fields are the only ones a patch may clear: an
      // operator who picks a level and then wants the provider's own default
      // back has no other way to say so. `null`, `''` and `'default'` all mean
      // that, and each is a real change rather than an empty patch.
      for (const key of ['defaultAgentReasoningEffort', 'defaultMemoryReasoningEffort'] as const) {
        const raw = body[key];
        if (raw === undefined) {
          continue;
        }
        if (raw === null || raw === '' || raw === 'default') {
          recognised += 1;
          delete next[key];
          continue;
        }
        if (!isReasoningEffort(raw)) {
          return { ok: false, error: 'invalid_reasoning_effort' };
        }
        recognised += 1;
        next[key] = raw;
      }

      if (recognised === 0) {
        return { ok: false, error: 'empty_models_patch' };
      }

      // A default that names nothing is a menu entry that cannot be used.
      if (!providerServes(next.providers, next.defaultAgentProviderId, next.defaultAgentModel)) {
        return { ok: false, error: 'unknown_default_agent_model' };
      }
      if (!providerServes(next.providers, next.defaultMemoryProviderId, next.defaultMemoryModel)) {
        return { ok: false, error: 'unknown_default_memory_model' };
      }

      try {
        persist(next);
      } catch {
        return { ok: false, error: 'models_config_write_failed' };
      }
      data = next;
      return { ok: true, data: view() };
    },
  };
}

export interface ResolvedAgentModel {
  settings: ModelSettings;
  providerId: string;
  providerName: string;
  /** Where the brain came from: its own frozen file, the roster, or `.env`. */
  source: 'binding' | 'roster' | 'env';
}

/**
 * The brain one agent runs on, resolved in the order that protects it best.
 *
 *  1. The frozen binding in the agent's own home. This is authoritative: the
 *     agent keeps the brain it was born with or was switched to, whatever the
 *     operator later does to the roster.
 *  2. The ledger's model name, matched against the roster — the path for an
 *     agent born before this feature existed and so without a binding.
 *  3. The `.env` default. An agent must always get a brain, even from a roster
 *     the operator has emptied out under it.
 */
export function resolveAgentModel(input: {
  binding: AgentModelBindingLike | null;
  store: ModelConfigStore;
  ledgerModel: string;
  fallback: ModelSettings;
}): ResolvedAgentModel {
  const { binding, store, ledgerModel, fallback } = input;
  if (binding !== null) {
    return {
      settings: {
        baseUrl: binding.baseUrl,
        apiKey: binding.apiKey,
        model: binding.model,
        ...(isReasoningEffort(binding.reasoningEffort)
          ? { reasoningEffort: binding.reasoningEffort }
          : {}),
      },
      providerId: binding.providerId,
      providerName: binding.providerName,
      source: 'binding',
    };
  }
  const provider = store.providerOfModel(ledgerModel);
  if (provider !== null) {
    // An agent born before the roster has only a model name on its ledger row,
    // so the operator's chosen thinking level for that same model is the only
    // place it can come from. A different model name carries no effort: the
    // level was never chosen for it.
    const defaultSelection = store.defaultAgentSelection();
    const effort =
      ledgerModel === defaultSelection.model ? defaultSelection.reasoningEffort : undefined;
    return {
      settings: {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: ledgerModel,
        ...(isReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
      },
      providerId: provider.id,
      providerName: provider.name,
      source: 'roster',
    };
  }
  const defaultSelection = store.defaultAgentSelection();
  const defaultProvider = store.getProvider(defaultSelection.providerId);
  const settings = store.settingsFor(defaultSelection);
  if (settings !== null && defaultProvider !== null) {
    return {
      settings,
      providerId: defaultProvider.id,
      providerName: defaultProvider.name,
      source: 'roster',
    };
  }
  return { settings: fallback, providerId: '', providerName: '', source: 'env' };
}

/** The shape `resolveAgentModel` needs; kept structural so binding.ts stays free of this module. */
export interface AgentModelBindingLike {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}
