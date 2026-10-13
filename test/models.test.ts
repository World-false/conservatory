import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILE_NAME,
  isReasoningEffort,
  type ModelSettings,
} from '../src/config';
import {
  MODEL_BINDING_FILE,
  modelBindingPath,
  readModelBinding,
  writeModelBinding,
} from '../src/organs/models/binding';
import {
  createModelConfigStore,
  modelsFilePath,
  persistModelsConfig,
  readModelsConfig,
  resolveAgentModel,
  seedFromEnv,
  type ModelsConfigData,
} from '../src/organs/models/store';
import {
  DEFERRED_NOTICE,
  IMMEDIATE_NOTICE,
  switchAgentModel,
} from '../src/organs/models/switch';
import { modelFingerprint, shouldRetireProcess } from '../src/organs/models/reconcile';
import {
  birthAgent,
  createHarness,
  simpleModelsData,
  TEST_ENV_MODELS,
  testModelStore,
  type Harness,
} from './helpers';

const TWO_PROVIDERS: ModelsConfigData = {
  defaultAgentProviderId: 'openai',
  defaultAgentModel: 'gpt-4o',
  defaultMemoryProviderId: 'deepseek',
  defaultMemoryModel: 'deepseek-chat',
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      models: ['gpt-4o', 'gpt-4o-mini'],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-deepseek',
      models: ['deepseek-chat'],
    },
  ],
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempConfigPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'conservatory-models-'));
  tempRoots.push(root);
  return path.join(root, CONFIG_FILE_NAME);
}

/** A store over a real temp roster file, so persistence is proved, not mocked. */
function fileStore(configPath: string, data?: ModelsConfigData) {
  writeFileSync(configPath, JSON.stringify({ satietyMax: 100 }, null, 2), 'utf8');
  if (data !== undefined) {
    persistModelsConfig(modelsFilePath(configPath), data);
  }
  return createModelConfigStore({ configPath, env: TEST_ENV_MODELS });
}

describe('the model roster', () => {
  it('seeds itself from the environment into its own file on first read', () => {
    const configPath = tempConfigPath();
    writeFileSync(configPath, JSON.stringify({ satietyMax: 100, consolePort: 4317 }, null, 2), 'utf8');
    // Nothing on disk yet: this is an install from before the feature.
    expect(readModelsConfig(modelsFilePath(configPath))).toBeNull();

    const store = createModelConfigStore({ configPath, env: TEST_ENV_MODELS });
    const view = store.view();
    expect(view.providers).toHaveLength(1);
    expect(view.providers[0].id).toBe('default');
    expect(view.providers[0].baseUrl).toBe(TEST_ENV_MODELS.agent.baseUrl);
    expect(view.providers[0].apiKey).toBe(TEST_ENV_MODELS.agent.apiKey);
    expect(view.providers[0].models).toEqual(['agent-model', 'memory-model']);
    expect(view.defaultAgentModel).toBe('agent-model');
    expect(view.defaultMemoryModel).toBe('memory-model');

    // It was written into its own file, and the config file was not touched at
    // all — which is the whole point: the roster holds keys, config does not.
    expect(store.modelsPath).toBe(modelsFilePath(configPath));
    expect(existsSync(store.modelsPath)).toBe(true);
    const configOnDisk = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(configOnDisk['satietyMax']).toBe(100);
    expect(configOnDisk['consolePort']).toBe(4317);
    expect(Object.keys(configOnDisk)).toEqual(['satietyMax', 'consolePort']);
    expect(readFileSync(configPath, 'utf8')).not.toContain(TEST_ENV_MODELS.agent.apiKey);

    // A second store reads what the first wrote instead of re-seeding.
    const again = createModelConfigStore({ configPath, env: TEST_ENV_MODELS });
    expect(again.view()).toEqual(view);
  });

  it('never writes a provider key into the git-tracked config file', () => {
    const configPath = tempConfigPath();
    writeFileSync(configPath, JSON.stringify({ satietyMax: 100 }, null, 2), 'utf8');
    const before = readFileSync(configPath, 'utf8');

    const store = createModelConfigStore({ configPath, env: TEST_ENV_MODELS });
    const set = store.update({
      providers: TWO_PROVIDERS.providers,
      defaultAgentProviderId: 'openai',
      defaultAgentModel: 'gpt-4o',
      defaultMemoryProviderId: 'deepseek',
      defaultMemoryModel: 'deepseek-chat',
    });
    expect(set.ok).toBe(true);
    expect(store.update({ defaultMemoryModel: 'deepseek-chat' }).ok).toBe(true);

    // The config file is byte-for-byte what it was; every key went elsewhere.
    expect(readFileSync(configPath, 'utf8')).toBe(before);
    const roster = readFileSync(store.modelsPath, 'utf8');
    expect(roster).toContain('sk-openai');
    expect(roster).toContain('sk-deepseek');
  });

  it('keeps one model name once when both roles point at the same model', () => {
    const seeded = seedFromEnv({
      agent: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'same-model' },
      memory: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'same-model' },
    });
    expect(seeded.providers[0].models).toEqual(['same-model']);
    expect(seeded.defaultAgentModel).toBe('same-model');
    expect(seeded.defaultMemoryModel).toBe('same-model');
  });

  it('reads, updates and persists a two-provider roster', () => {
    const configPath = tempConfigPath();
    const store = fileStore(configPath, TWO_PROVIDERS);
    expect(store.view().providers.map((provider) => provider.id)).toEqual(['openai', 'deepseek']);

    const updated = store.update({
      defaultAgentProviderId: 'deepseek',
      defaultAgentModel: 'deepseek-chat',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      return;
    }
    expect(updated.data.defaultAgentProviderId).toBe('deepseek');
    expect(updated.data.defaultAgentModel).toBe('deepseek-chat');
    // A partial patch leaves everything it did not carry alone.
    expect(updated.data.defaultMemoryModel).toBe('deepseek-chat');
    expect(updated.data.providers).toHaveLength(2);

    // It reached the file, and a fresh store sees it.
    expect(readModelsConfig(modelsFilePath(configPath))?.defaultAgentModel).toBe('deepseek-chat');
    expect(fileStore(configPath, TWO_PROVIDERS).defaultAgentSelection()).toEqual({
      providerId: 'openai',
      model: 'gpt-4o',
    });

    // A full provider replacement persists too.
    const replaced = store.update({
      providers: [
        {
          id: 'local',
          name: '本地',
          baseUrl: 'http://127.0.0.1:7863/v1',
          apiKey: 'sk-local',
          models: ['local-a', 'local-b'],
        },
      ],
      defaultAgentProviderId: 'local',
      defaultAgentModel: 'local-a',
      defaultMemoryProviderId: 'local',
      defaultMemoryModel: 'local-b',
    });
    expect(replaced.ok).toBe(true);
    expect(readModelsConfig(modelsFilePath(configPath))?.providers[0].id).toBe('local');
  });

  it('refuses a patch that names a default no provider serves', () => {
    const configPath = tempConfigPath();
    const store = fileStore(configPath, TWO_PROVIDERS);

    const wrongModel = store.update({ defaultAgentModel: 'nope' });
    expect(wrongModel).toEqual({ ok: false, error: 'unknown_default_agent_model' });

    const wrongProvider = store.update({
      defaultMemoryProviderId: 'openai',
      defaultMemoryModel: 'deepseek-chat',
    });
    expect(wrongProvider).toEqual({ ok: false, error: 'unknown_default_memory_model' });

    // Nothing was written by either refusal.
    expect(readModelsConfig(modelsFilePath(configPath))?.defaultAgentModel).toBe('gpt-4o');
    expect(store.view().defaultMemoryModel).toBe('deepseek-chat');
  });

  it('refuses a malformed provider list with a code the console can translate', () => {
    const configPath = tempConfigPath();
    const store = fileStore(configPath, TWO_PROVIDERS);
    const before = store.view();

    expect(store.update({ providers: 'not a list' })).toEqual({ ok: false, error: 'invalid_providers' });
    expect(store.update({ providers: [] })).toEqual({ ok: false, error: 'no_providers' });
    expect(
      store.update({
        providers: [{ id: 'x', name: 'X', baseUrl: 'http://x/v1', apiKey: 'k', models: [] }],
      }),
    ).toEqual({ ok: false, error: 'empty_provider_models' });
    expect(
      store.update({
        providers: [{ id: 'bad id!', name: 'X', baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] }],
      }),
    ).toEqual({ ok: false, error: 'invalid_provider_id' });
    expect(
      store.update({
        providers: [
          { id: 'dup', name: 'A', baseUrl: 'http://x/v1', apiKey: 'k', models: ['m'] },
          { id: 'dup', name: 'B', baseUrl: 'http://y/v1', apiKey: 'k', models: ['n'] },
        ],
      }),
    ).toEqual({ ok: false, error: 'duplicate_provider_id' });
    expect(store.update({})).toEqual({ ok: false, error: 'empty_models_patch' });
    expect(store.update(null)).toEqual({ ok: false, error: 'invalid_models_patch' });

    // Every refusal above left the roster exactly where it was.
    expect(store.view()).toEqual(before);
  });

  it('refuses to delete a provider a living agent is still bound to', () => {
    const configPath = tempConfigPath();
    let bound = [{ agent: 'ada', providerId: 'deepseek' }];
    const store = createModelConfigStore({
      configPath,
      env: TEST_ENV_MODELS,
      listBoundAgents: () => bound,
      readPersisted: () => TWO_PROVIDERS,
      persist: () => undefined,
    });
    expect(store.view().providers.map((provider) => provider.id)).toEqual(['openai', 'deepseek']);

    const refused = store.update({ providers: [TWO_PROVIDERS.providers[0]] });
    expect(refused.ok).toBe(false);
    if (refused.ok) {
      return;
    }
    expect(refused.error).toBe('provider_in_use');
    expect(refused.agents).toEqual(['ada']);
    expect(store.getProvider('deepseek')).not.toBeNull();

    // Once nothing is bound to it, the same deletion is allowed — but the
    // defaults that named it have to move with it, or they would be orphaned.
    bound = [{ agent: 'ada', providerId: 'openai' }];
    const orphaned = store.update({ providers: [TWO_PROVIDERS.providers[0]] });
    expect(orphaned).toEqual({ ok: false, error: 'unknown_default_memory_model' });

    const allowed = store.update({
      providers: [TWO_PROVIDERS.providers[0]],
      defaultMemoryProviderId: 'openai',
      defaultMemoryModel: 'gpt-4o-mini',
    });
    expect(allowed.ok).toBe(true);
    expect(store.getProvider('deepseek')).toBeNull();
  });

  it('reports a failed write instead of pretending the roster changed', () => {
    const configPath = tempConfigPath();
    writeFileSync(configPath, JSON.stringify({ satietyMax: 100 }, null, 2), 'utf8');
    const store = createModelConfigStore({
      configPath,
      env: TEST_ENV_MODELS,
      readPersisted: () => TWO_PROVIDERS,
      persist: () => {
        throw new Error('read-only file');
      },
    });
    const result = store.update({ defaultAgentModel: 'gpt-4o-mini' });
    expect(result).toEqual({ ok: false, error: 'models_config_write_failed' });
    expect(store.view().defaultAgentModel).toBe('gpt-4o');
  });

  it('survives a hand-edited roster file by treating it as unconfigured', () => {
    const configPath = tempConfigPath();
    writeFileSync(configPath, JSON.stringify({ satietyMax: 100 }, null, 2), 'utf8');
    writeFileSync(
      modelsFilePath(configPath),
      JSON.stringify({ providers: [], defaultAgentProviderId: 'x' }, null, 2),
      'utf8',
    );
    expect(readModelsConfig(modelsFilePath(configPath))).toBeNull();
    const store = createModelConfigStore({ configPath, env: TEST_ENV_MODELS });
    expect(store.view().providers).toHaveLength(1);
  });
});

describe('the frozen binding in an agent own home', () => {
  it('round-trips a complete snapshot, key included', () => {
    const configPath = tempConfigPath();
    writeFileSync(configPath, JSON.stringify({}, null, 2), 'utf8');
    const root = path.dirname(configPath);
    const paths = {
      rootDir: root,
      configPath,
      envPath: path.join(root, '.env'),
      agentsDir: path.join(root, 'AGENTS'),
      supervisorDir: path.join(root, 'SUPERVISOR'),
      ledgerPath: path.join(root, 'SUPERVISOR', 'ledger.db'),
      blackboxDir: path.join(root, 'SUPERVISOR', 'blackbox'),
      promptsDir: path.join(root, 'prompts'),
    };

    expect(readModelBinding(paths, 'ada')).toBeNull();
    writeModelBinding(paths, 'ada', {
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-deepseek',
      model: 'deepseek-chat',
      boundAt: 1700000000000,
    });
    expect(modelBindingPath(paths, 'ada')).toBe(path.join(paths.agentsDir, 'ada', MODEL_BINDING_FILE));
    const read = readModelBinding(paths, 'ada');
    expect(read).toEqual({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-deepseek',
      model: 'deepseek-chat',
      boundAt: 1700000000000,
    });
  });

  it('returns null for a torn or ill-typed file rather than refusing to wake the agent', () => {
    const h = createHarness();
    try {
      const file = modelBindingPath(h.paths, 'ada');
      birthAgent(h, 'ada');
      writeFileSync(file, '{ not json', 'utf8');
      expect(readModelBinding(h.paths, 'ada')).toBeNull();
      writeFileSync(file, JSON.stringify({ providerId: 'x' }), 'utf8');
      expect(readModelBinding(h.paths, 'ada')).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('writes the binding into the agent own folder, next to MEMORY', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      writeModelBinding(h.paths, 'ada', {
        providerId: 'main',
        providerName: '主提供商',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'k',
        model: 'agent-model',
        boundAt: h.clock.now(),
      });
      expect(existsSync(path.join(h.paths.agentsDir, 'ada', MODEL_BINDING_FILE))).toBe(true);
      expect(readModelBinding(h.paths, 'ada')?.model).toBe('agent-model');
    } finally {
      h.cleanup();
    }
  });
});

describe('resolving which brain an agent runs on', () => {
  it('prefers the agent own binding over the roster', () => {
    const h = createHarness();
    try {
      const { store } = testModelStore(h, { data: TWO_PROVIDERS });
      const resolved = resolveAgentModel({
        binding: {
          providerId: 'deepseek',
          providerName: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-deepseek',
          model: 'deepseek-chat',
        },
        store,
        ledgerModel: 'gpt-4o',
        fallback: TEST_ENV_MODELS.agent,
      });
      expect(resolved.source).toBe('binding');
      expect(resolved.settings.model).toBe('deepseek-chat');
      expect(resolved.settings.baseUrl).toBe('https://api.deepseek.com/v1');
      expect(resolved.settings.apiKey).toBe('sk-deepseek');
      expect(resolved.providerId).toBe('deepseek');
    } finally {
      h.cleanup();
    }
  });

  it('falls back to the roster by model name for an agent born before this feature', () => {
    const h = createHarness();
    try {
      const { store } = testModelStore(h, { data: TWO_PROVIDERS });
      const resolved = resolveAgentModel({
        binding: null,
        store,
        ledgerModel: 'gpt-4o-mini',
        fallback: TEST_ENV_MODELS.agent,
      });
      expect(resolved.source).toBe('roster');
      expect(resolved.providerId).toBe('openai');
      expect(resolved.settings.model).toBe('gpt-4o-mini');
      expect(resolved.settings.apiKey).toBe('sk-openai');
    } finally {
      h.cleanup();
    }
  });

  it('falls back to the environment when the roster names nothing', () => {
    const h = createHarness();
    try {
      const { store } = testModelStore(h, { data: TWO_PROVIDERS });
      const resolved = resolveAgentModel({
        binding: null,
        store,
        ledgerModel: 'a-model-nobody-configured',
        fallback: TEST_ENV_MODELS.agent,
      });
      expect(resolved.source).toBe('roster');
      expect(resolved.providerId).toBe('openai');
      expect(resolved.settings.model).toBe('gpt-4o');
    } finally {
      h.cleanup();
    }
  });

  it('never leaves an agent without a brain, even against an empty roster', () => {
    const h = createHarness();
    try {
      const { store } = testModelStore(h);
      // Force the roster out from under the resolver the way only an operator
      // with a hand-edited file could.
      const empty = { ...simpleModelsData(), providers: [] } as unknown as ModelsConfigData;
      const broken = createModelConfigStore({
        configPath: h.paths.configPath,
        env: TEST_ENV_MODELS,
        readPersisted: () => empty,
        persist: () => undefined,
      });
      const resolved = resolveAgentModel({
        binding: null,
        store: broken,
        ledgerModel: 'gone',
        fallback: TEST_ENV_MODELS.agent,
      });
      expect(resolved.source).toBe('env');
      expect(resolved.settings).toEqual(TEST_ENV_MODELS.agent);
      expect(store.view().providers).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});

describe('reconciling a running process against the ledger', () => {
  it('retires a process whose started model no longer resolves', () => {
    // The deferred switch landing: the process still runs the old brain.
    expect(
      shouldRetireProcess({ startedModel: 'gpt-4o', resolvedModel: 'deepseek-chat' }),
    ).toBe(true);
  });

  it('leaves an up-to-date process alone', () => {
    expect(
      shouldRetireProcess({ startedModel: 'deepseek-chat', resolvedModel: 'deepseek-chat' }),
    ).toBe(false);
  });

  it('never retires a process that has not started, or one with no resolvable model', () => {
    expect(shouldRetireProcess({ startedModel: null, resolvedModel: 'gpt-4o' })).toBe(false);
    expect(shouldRetireProcess({ startedModel: 'gpt-4o', resolvedModel: null })).toBe(false);
  });
});

describe('the fingerprint that decides whether a process is out of date', () => {
  const base: ModelSettings = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-deepseek',
    model: 'deepseek-chat',
  };

  it('is stable for the same brain and provider', () => {
    expect(modelFingerprint(base, 'deepseek')).toBe(modelFingerprint({ ...base }, 'deepseek'));
  });

  it('changes when the provider changes, even under the same model name', () => {
    // The same model name on two endpoints is two different brains; comparing
    // names alone would let a process keep answering on the old one.
    const other = { ...base, baseUrl: 'https://api.other.com/v1', apiKey: 'sk-other' };
    expect(modelFingerprint(base, 'deepseek')).not.toBe(modelFingerprint(other, 'deepseek'));
    expect(modelFingerprint(base, 'deepseek')).not.toBe(modelFingerprint(base, 'openai'));
  });

  it('changes when the base URL or the key is retuned without renaming anything', () => {
    const retunedUrl = { ...base, baseUrl: 'https://new.example.com/v1' };
    const rotatedKey = { ...base, apiKey: 'sk-rotated' };
    const renamed = { ...base, model: 'deepseek-reasoner' };
    const fingerprint = modelFingerprint(base, 'deepseek');
    expect(modelFingerprint(retunedUrl, 'deepseek')).not.toBe(fingerprint);
    expect(modelFingerprint(rotatedKey, 'deepseek')).not.toBe(fingerprint);
    expect(modelFingerprint(renamed, 'deepseek')).not.toBe(fingerprint);
  });

  it('changes when the thinking level changes, and reads "unset" as its own level', () => {
    const low = { ...base, reasoningEffort: 'low' as const };
    const high = { ...base, reasoningEffort: 'high' as const };
    expect(modelFingerprint(low, 'deepseek')).not.toBe(modelFingerprint(high, 'deepseek'));
    // Unset is not the same as any level: it is a different request to the model.
    expect(modelFingerprint(base, 'deepseek')).not.toBe(modelFingerprint(low, 'deepseek'));
  });

  it('treats a missing provider id as part of the identity, not as a missing value', () => {
    // `.env`-resolved agents carry no provider at all, and that is a fact about
    // their brain rather than a gap to be filled in.
    expect(modelFingerprint(base)).toBe(modelFingerprint(base, ''));
    expect(modelFingerprint(base, '')).not.toBe(modelFingerprint(base, 'deepseek'));
  });
});

describe('the operator\u2019s thinking level on the roster', () => {
  it('stores a chosen level and hands it to every settings lookup', () => {
    const configPath = tempConfigPath();
    const store = fileStore(configPath, TWO_PROVIDERS);

    const set = store.update({
      defaultAgentReasoningEffort: 'high',
      defaultMemoryReasoningEffort: 'low',
    });
    expect(set.ok).toBe(true);
    expect(store.view().defaultAgentReasoningEffort).toBe('high');
    expect(store.view().defaultMemoryReasoningEffort).toBe('low');
    expect(store.defaultAgentSelection()).toEqual({
      providerId: 'openai',
      model: 'gpt-4o',
      reasoningEffort: 'high',
    });
    expect(store.defaultMemorySelection()).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'low',
    });
    expect(store.settingsFor(store.defaultAgentSelection())).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'gpt-4o',
      reasoningEffort: 'high',
    });

    // It reached the file, so the choice survives a restart.
    const reread = readModelsConfig(modelsFilePath(configPath));
    expect(reread?.defaultAgentReasoningEffort).toBe('high');
    expect(reread?.defaultMemoryReasoningEffort).toBe('low');
  });

  it('omits the level entirely when none was chosen, so old shapes still compare equal', () => {
    const configPath = tempConfigPath();
    const store = fileStore(configPath, TWO_PROVIDERS);

    // The property is absent, not present-and-undefined: a caller that spreads
    // these settings must not gain a key it never asked for.
    expect('reasoningEffort' in store.defaultAgentSelection()).toBe(false);
    expect('reasoningEffort' in store.defaultMemorySelection()).toBe(false);
    expect('reasoningEffort' in (store.settingsFor(store.defaultAgentSelection()) ?? {})).toBe(false);
    expect(store.settingsFor({ providerId: 'openai', model: 'gpt-4o' })).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-openai',
      model: 'gpt-4o',
    });
  });

  it('clears a level with null or with "default", and that is a real change', () => {
    const configPath = tempConfigPath();
    const store = fileStore(configPath, TWO_PROVIDERS);
    expect(store.update({ defaultAgentReasoningEffort: 'medium' }).ok).toBe(true);

    // Clearing is recognised work: an otherwise-empty patch must not be
    // reported as "nothing to update", or the panel could never reset a level.
    const cleared = store.update({ defaultAgentReasoningEffort: null });
    expect(cleared.ok).toBe(true);
    expect('reasoningEffort' in store.defaultAgentSelection()).toBe(false);
    expect(readModelsConfig(modelsFilePath(configPath))?.defaultAgentReasoningEffort).toBeUndefined();

    expect(store.update({ defaultMemoryReasoningEffort: 'high' }).ok).toBe(true);
    const byName = store.update({ defaultMemoryReasoningEffort: 'default' });
    expect(byName.ok).toBe(true);
    expect('reasoningEffort' in store.defaultMemorySelection()).toBe(false);

    // Clearing one that was never set is still a recognised field.
    expect(store.update({ defaultMemoryReasoningEffort: '' }).ok).toBe(true);
  });

  it('refuses an unknown level with a code the console can translate', () => {
    const configPath = tempConfigPath();
    const store = fileStore(configPath, TWO_PROVIDERS);
    expect(store.update({ defaultAgentReasoningEffort: 'medium' }).ok).toBe(true);
    const before = store.view();

    // A typo must not be quietly read as "unset": that would look like success.
    expect(store.update({ defaultAgentReasoningEffort: 'very-high' })).toEqual({
      ok: false,
      error: 'invalid_reasoning_effort',
    });
    expect(store.update({ defaultMemoryReasoningEffort: 3 })).toEqual({
      ok: false,
      error: 'invalid_reasoning_effort',
    });
    expect(store.view()).toEqual(before);
    expect(readModelsConfig(modelsFilePath(configPath))?.defaultAgentReasoningEffort).toBe('medium');
  });

  it('treats a hand-edited level as unconfigured rather than guessing', () => {
    const configPath = tempConfigPath();
    writeFileSync(configPath, JSON.stringify({ satietyMax: 100 }, null, 2), 'utf8');
    const file = modelsFilePath(configPath);

    persistModelsConfig(file, { ...TWO_PROVIDERS, defaultAgentReasoningEffort: 'high' });
    expect(readModelsConfig(file)?.defaultAgentReasoningEffort).toBe('high');

    // `'default'` and an absent field both read as "no level", and the property
    // is left off so a roster written before this feature round-trips. Written
    // as raw JSON because `'default'` is not a level the typed API would accept
    // — it is exactly the hand-edited spelling this reader has to survive.
    writeFileSync(
      file,
      JSON.stringify({ ...TWO_PROVIDERS, defaultAgentReasoningEffort: 'default' }, null, 2),
      'utf8',
    );
    const asDefault = readModelsConfig(file);
    expect(asDefault?.defaultAgentReasoningEffort).toBeUndefined();
    expect('defaultAgentReasoningEffort' in (asDefault ?? {})).toBe(false);

    // A level nobody defined is a torn file: unconfigured, never guessed at.
    writeFileSync(
      file,
      JSON.stringify({ ...TWO_PROVIDERS, defaultMemoryReasoningEffort: 'turbo' }, null, 2),
      'utf8',
    );
    expect(readModelsConfig(file)).toBeNull();
  });

  it('knows the three levels and nothing else', () => {
    expect(['low', 'medium', 'high'].every((value) => isReasoningEffort(value))).toBe(true);
    for (const value of [undefined, null, '', 'default', 'none', 'minimal', 'xhigh', 1, {}]) {
      expect(isReasoningEffort(value)).toBe(false);
    }
  });
});

describe('the thinking level in a frozen binding and a live switch', () => {
  it('round-trips a level and leaves the property off when there is none', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      writeModelBinding(h.paths, 'ada', {
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek',
        model: 'deepseek-chat',
        reasoningEffort: 'high',
        boundAt: h.clock.now(),
      });
      expect(readModelBinding(h.paths, 'ada')?.reasoningEffort).toBe('high');

      // A snapshot without a level reads back without the key, so a binding
      // written before this feature still compares equal to itself.
      writeModelBinding(h.paths, 'ada', {
        providerId: 'deepseek',
        providerName: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-deepseek',
        model: 'deepseek-chat',
        boundAt: h.clock.now(),
      });
      const plain = readModelBinding(h.paths, 'ada');
      expect('reasoningEffort' in (plain ?? {})).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('ignores a level in the file that is not one of the three', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      const file = modelBindingPath(h.paths, 'ada');
      writeFileSync(
        file,
        JSON.stringify({
          providerId: 'deepseek',
          providerName: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-deepseek',
          model: 'deepseek-chat',
          reasoningEffort: 'turbo',
          boundAt: 1,
        }),
        'utf8',
      );
      const binding = readModelBinding(h.paths, 'ada');
      // The rest of the binding is still usable; only the bogus level is dropped.
      expect(binding?.model).toBe('deepseek-chat');
      expect('reasoningEffort' in (binding ?? {})).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('freezes the level the operator chose, records it, and says so in the notice', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada', 'gpt-4o');
      const fixture = testModelStore(h, { data: TWO_PROVIDERS });
      const retires: string[] = [];
      const notices: { agent: string; message: string }[] = [];
      const deps = {
        ledger: h.ledger,
        paths: h.paths,
        blackbox: h.blackbox,
        store: fixture.store,
        now: h.clock.now,
        isBusy: () => false,
        retireProcess: (agent: string) => {
          retires.push(agent);
        },
        onNotice: (agent: string, message: string) => {
          notices.push({ agent, message });
        },
      };

      const outcome = switchAgentModel(deps, 'ada', 'deepseek', 'deepseek-chat', 'high');
      expect(outcome.ok).toBe(true);
      expect(readModelBinding(h.paths, 'ada')?.reasoningEffort).toBe('high');

      // The permanent record names the level, so the operator can later tell a
      // switch that set one from a switch that cleared one.
      expect(h.ledger.listInterventions('ada')[0].detail).toBe(
        '切换模型为 DeepSeek · deepseek-chat（思考：high）',
      );
      expect(notices[0].message).toContain('（思考：high）');

      // And the black box carries it as a field, not only inside prose.
      const entries = h.blackbox.readDay('ada', new Date(h.clock.now()).toISOString().slice(0, 10));
      const switched = entries.find((entry) => entry.kind === 'intervention');
      expect(switched?.['reasoningEffort']).toBe('high');
      expect(retires).toEqual(['ada']);
    } finally {
      h.cleanup();
    }
  });

  it('leaves the wording and the snapshot exactly as before when no level is given', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada', 'gpt-4o');
      const fixture = testModelStore(h, { data: TWO_PROVIDERS });
      const deps = {
        ledger: h.ledger,
        paths: h.paths,
        blackbox: h.blackbox,
        store: fixture.store,
        now: h.clock.now,
        isBusy: () => false,
        retireProcess: () => undefined,
        onNotice: () => undefined,
      };

      expect(switchAgentModel(deps, 'ada', 'deepseek', 'deepseek-chat').ok).toBe(true);
      expect(h.ledger.listInterventions('ada')[0].detail).toBe('切换模型为 DeepSeek · deepseek-chat');
      expect('reasoningEffort' in (readModelBinding(h.paths, 'ada') ?? {})).toBe(false);

      // A switch is a full rewrite, so passing null clears a level set earlier
      // rather than silently leaving the old one in place.
      switchAgentModel(deps, 'ada', 'deepseek', 'deepseek-chat', 'high');
      expect(readModelBinding(h.paths, 'ada')?.reasoningEffort).toBe('high');
      switchAgentModel(deps, 'ada', 'deepseek', 'deepseek-chat', null);
      expect('reasoningEffort' in (readModelBinding(h.paths, 'ada') ?? {})).toBe(false);
      expect(h.ledger.listInterventions('ada')[2].detail).toBe('切换模型为 DeepSeek · deepseek-chat');
    } finally {
      h.cleanup();
    }
  });

  it('resolves the level out of a binding, and out of the roster for a legacy agent', () => {
    const h = createHarness();
    try {
      const fixture = testModelStore(h, { data: TWO_PROVIDERS });
      const fromBinding = resolveAgentModel({
        binding: {
          providerId: 'deepseek',
          providerName: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-deepseek',
          model: 'deepseek-chat',
          reasoningEffort: 'low',
        },
        store: fixture.store,
        ledgerModel: 'gpt-4o',
        fallback: TEST_ENV_MODELS.agent,
      });
      expect(fromBinding.settings.reasoningEffort).toBe('low');

      // A legacy agent has only a model name, so the level chosen for that same
      // model name is the one it gets.
      expect(fixture.store.update({ defaultAgentReasoningEffort: 'high' }).ok).toBe(true);
      const legacy = resolveAgentModel({
        binding: null,
        store: fixture.store,
        ledgerModel: 'gpt-4o',
        fallback: TEST_ENV_MODELS.agent,
      });
      expect(legacy.settings.reasoningEffort).toBe('high');

      // A different model name carries no level: none was ever chosen for it.
      const other = resolveAgentModel({
        binding: null,
        store: fixture.store,
        ledgerModel: 'gpt-4o-mini',
        fallback: TEST_ENV_MODELS.agent,
      });
      expect('reasoningEffort' in other.settings).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

describe('the operator switches a living agent model', () => {
  function switchDeps(h: Harness, options: { busy?: boolean; store?: ReturnType<typeof testModelStore> } = {}) {
    const fixture = options.store ?? testModelStore(h, { data: TWO_PROVIDERS });
    const retires: string[] = [];
    const notices: { agent: string; message: string }[] = [];
    return {
      fixture,
      retires,
      notices,
      deps: {
        ledger: h.ledger,
        paths: h.paths,
        blackbox: h.blackbox,
        store: fixture.store,
        now: h.clock.now,
        isBusy: () => options.busy === true,
        retireProcess: (agent: string) => {
          retires.push(agent);
        },
        onNotice: (agent: string, message: string) => {
          notices.push({ agent, message });
        },
      },
    };
  }

  it('switches an idle agent, rewriting the ledger and the binding at once', () => {
    const h = createHarness();
    try {
      const agent = birthAgent(h, 'ada', 'gpt-4o');
      const { deps, retires, fixture } = switchDeps(h);

      const outcome = switchAgentModel(deps, 'ada', 'deepseek', 'deepseek-chat');
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.deferred).toBe(false);
      expect(outcome.message).toBe(IMMEDIATE_NOTICE);

      // The ledger row: what every wake-up reads.
      expect(h.ledger.getAgent('ada')?.model).toBe('deepseek-chat');
      expect(agent.model).toBe('gpt-4o');

      // The frozen binding: what makes the choice survive the roster changing.
      const binding = readModelBinding(h.paths, 'ada');
      expect(binding?.providerId).toBe('deepseek');
      expect(binding?.providerName).toBe('DeepSeek');
      expect(binding?.apiKey).toBe('sk-deepseek');
      expect(binding?.model).toBe('deepseek-chat');

      // The intervention, permanently, naming the provider and the model.
      const interventions = h.ledger.listInterventions('ada');
      expect(interventions).toHaveLength(1);
      expect(interventions[0].kind).toBe('model_switched');
      expect(interventions[0].detail).toBe('切换模型为 DeepSeek · deepseek-chat');
      expect(interventions[0].at).toBe(h.clock.now());

      // Idle: the cached process is retired so the next wake-up forks anew.
      expect(retires).toEqual(['ada']);
      expect(fixture.written).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('saves a busy agent model, defers it, and still retires nothing yet', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada', 'gpt-4o');
      const { deps, retires, notices } = switchDeps(h, { busy: true });

      const outcome = switchAgentModel(deps, 'ada', 'deepseek', 'deepseek-chat');
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        return;
      }
      expect(outcome.deferred).toBe(true);
      expect(outcome.message).toBe(DEFERRED_NOTICE);
      expect(outcome.message).toBe('模型修改已保存。当前正在执行任务，将在本轮运行完成后下一次唤醒时生效。');

      // The decision is durable even though the process is untouched.
      expect(h.ledger.getAgent('ada')?.model).toBe('deepseek-chat');
      expect(readModelBinding(h.paths, 'ada')?.model).toBe('deepseek-chat');
      expect(h.ledger.listInterventions('ada').map((row) => row.kind)).toEqual(['model_switched']);
      // The live round is not cut in half: the process is left alone.
      expect(retires).toEqual([]);
      expect(notices[0].message).toContain('下一次唤醒生效');
    } finally {
      h.cleanup();
    }
  });

  it('refuses a dead agent, an unknown provider and a model the provider does not serve', () => {
    const h = createHarness({ values: { maxSlots: 4 } });
    try {
      birthAgent(h, 'ada', 'gpt-4o');
      birthAgent(h, 'bob', 'gpt-4o');
      h.ledger.markAgentDead('bob');
      const { deps, retires } = switchDeps(h);

      expect(switchAgentModel(deps, 'ghost', 'openai', 'gpt-4o')).toEqual({
        ok: false,
        error: 'agent_not_found',
      });
      // A dead agent cannot be given a new brain: the trigger would refuse it.
      expect(switchAgentModel(deps, 'bob', 'openai', 'gpt-4o')).toEqual({
        ok: false,
        error: 'agent_dead',
      });
      expect(switchAgentModel(deps, 'ada', 'nobody', 'gpt-4o')).toEqual({
        ok: false,
        error: 'unknown_provider',
      });
      expect(switchAgentModel(deps, 'ada', 'openai', 'deepseek-chat')).toEqual({
        ok: false,
        error: 'unknown_model',
      });

      // Not one refusal touched the ledger, the binding or the process.
      expect(h.ledger.getAgent('ada')?.model).toBe('gpt-4o');
      expect(h.ledger.listInterventions('ada')).toEqual([]);
      expect(retires).toEqual([]);
      expect(existsSync(modelBindingPath(h.paths, 'ada'))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('refuses to rewrite a dead agent through the ledger itself', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada');
      expect(h.ledger.updateAgentModel('ada', 'other-model')).toBe(true);
      expect(h.ledger.getAgent('ada')?.model).toBe('other-model');

      h.ledger.markAgentDead('ada');
      expect(h.ledger.updateAgentModel('ada', 'third-model')).toBe(false);
      expect(h.ledger.getAgent('ada')?.model).toBe('other-model');
      // An agent that never existed changes nothing either.
      expect(h.ledger.updateAgentModel('ghost', 'x')).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it('keeps a switched brain stable when the operator later edits the roster', () => {
    const h = createHarness();
    try {
      birthAgent(h, 'ada', 'gpt-4o');
      const { deps, fixture } = switchDeps(h);
      expect(switchAgentModel(deps, 'ada', 'deepseek', 'deepseek-chat').ok).toBe(true);

      // The operator retunes the provider ada is bound to, then removes the
      // other one entirely. Ada's own frozen file is what she keeps running on.
      const retuned = fixture.store.update({
        providers: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            baseUrl: 'https://new-endpoint.example.com/v1',
            apiKey: 'sk-rotated',
            models: ['deepseek-chat', 'deepseek-reasoner'],
          },
        ],
        defaultAgentProviderId: 'deepseek',
        defaultAgentModel: 'deepseek-chat',
        defaultMemoryProviderId: 'deepseek',
        defaultMemoryModel: 'deepseek-reasoner',
      });
      expect(retuned.ok).toBe(true);

      const resolved = resolveAgentModel({
        binding: readModelBinding(h.paths, 'ada'),
        store: fixture.store,
        ledgerModel: h.ledger.getAgent('ada')?.model ?? '',
        fallback: TEST_ENV_MODELS.agent,
      });
      expect(resolved.source).toBe('binding');
      expect(resolved.settings.baseUrl).toBe('https://api.deepseek.com/v1');
      expect(resolved.settings.apiKey).toBe('sk-deepseek');
      expect(resolved.settings.model).toBe('deepseek-chat');
    } finally {
      h.cleanup();
    }
  });
});
