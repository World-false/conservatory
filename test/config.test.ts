import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, CONFIG_FILE_NAME, loadAppConfig } from '../src/config';

const VALID_VALUES = {
  satietyDecayPerSecond: 0.05,
  satietyMax: 100,
  initialSatiety: 100,
  initialBalance: 100,
  mealPrice: 15,
  satietyPerMeal: 25,
  heartbeatSeconds: 300,
  maxSlots: 1,
  memoryCapChars: 8000,
  roundContextCapTokens: 152000,
  maxToolCallsPerRound: 50,
  modelRequestTimeoutSeconds: 120,
  taskClaimTimeoutHours: 24,
  redactionIntervalSeconds: 60,
  redactionCharsPerTick: 20,
  redactionMinRanges: 1,
  redactionMaxRanges: 3,
  deathLineChars: 2000,
  ordinaryTreatmentPrice: 25,
  completeTreatmentPrice: 80,
  exchangeRate: null,
  consolePort: 4317,
};

const VALID_ENV = {
  AGENT_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
  AGENT_MODEL_API_KEY: 'agent-key',
  AGENT_MODEL_NAME: 'agent-model',
  MEMORY_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
  MEMORY_MODEL_API_KEY: 'memory-key',
  MEMORY_MODEL_NAME: 'memory-model',
};

function withConfigFile(value: unknown, run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'conservatory-config-'));
  try {
    writeFileSync(path.join(root, CONFIG_FILE_NAME), JSON.stringify(value, null, 2), 'utf8');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function configError(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    if (error instanceof ConfigError) {
      return error.message;
    }
  }
  throw new Error('the configuration should have been refused');
}

describe('configuration', () => {
  it('reads the committed config file', () => {
    const config = loadAppConfig({ rootDir: process.cwd(), env: VALID_ENV });
    expect(config.values.satietyDecayPerSecond).toBe(0.00028935);
    expect(config.values.satietyMax).toBe(100);
    expect(config.values.mealPrice).toBe(10);
    expect(config.values.satietyPerMeal).toBe(35);
    expect(config.values.heartbeatSeconds).toBe(1500);
    expect(config.values.maxSlots).toBe(100000);
    expect(config.values.memoryCapChars).toBe(3000000);
    expect(config.values.roundContextCapTokens).toBe(900000);
    expect(config.values.maxToolCallsPerRound).toBe(50);
    expect(config.values.modelRequestTimeoutSeconds).toBe(120);
    expect(config.values.taskClaimTimeoutHours).toBe(24);
    expect(config.values.redactionIntervalSeconds).toBe(60);
    expect(config.values.redactionCharsPerTick).toBe(46);
    expect(config.values.redactionMinRanges).toBe(2);
    expect(config.values.redactionMaxRanges).toBe(6);
    expect(config.values.deathLineChars).toBe(400000);
    expect(config.values.ordinaryTreatmentPrice).toBe(25);
    expect(config.values.completeTreatmentPrice).toBe(80);
    expect(config.values.consolePort).toBe(4317);
    expect(config.values.exchangeRate).toBe(200);
    expect(config.paths.ledgerPath).toBe(path.join(process.cwd(), 'SUPERVISOR', 'ledger.db'));
    expect(config.paths.blackboxDir).toBe(path.join(process.cwd(), 'SUPERVISOR', 'blackbox'));
    expect(config.models.agent.model).toBe('agent-model');
    expect(config.models.memory.model).toBe('memory-model');
  });

  it('refuses an unreachable death line and more ranges than characters', () => {
    withConfigFile({ ...VALID_VALUES, redactionMaxRanges: 40 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"redactionMaxRanges"');
    });
    withConfigFile({ ...VALID_VALUES, redactionMinRanges: 5, redactionMaxRanges: 2 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"redactionMaxRanges" must be at least "redactionMinRanges"');
    });
    withConfigFile({ ...VALID_VALUES, deathLineChars: 8000 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"memoryCapChars" must be greater than "deathLineChars"');
    });
    // A MEMORY that no round could ever fit: the agent would wake up and be
    // ended by the cap every time, which is a permanent sleep.
    withConfigFile({ ...VALID_VALUES, memoryCapChars: 400000, roundContextCapTokens: 200000 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"roundContextCapTokens" must be at least 250000');
    });
    // Exactly the minimum is allowed: ceil(400000 / 4) + 150000.
    withConfigFile({ ...VALID_VALUES, memoryCapChars: 400000, roundContextCapTokens: 250000 }, (root) => {
      const config = loadAppConfig({ rootDir: root, env: VALID_ENV });
      expect(config.values.roundContextCapTokens).toBe(250000);
    });
    withConfigFile({ ...VALID_VALUES, redactionCharsPerTick: 0 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"redactionCharsPerTick"');
    });
    withConfigFile({ ...VALID_VALUES, ordinaryTreatmentPrice: -1 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"ordinaryTreatmentPrice"');
    });
    withConfigFile({ ...VALID_VALUES, completeTreatmentPrice: -0.5 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"completeTreatmentPrice"');
    });
    withConfigFile({ ...VALID_VALUES, redactionIntervalSeconds: 0 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"redactionIntervalSeconds"');
    });
    withConfigFile({ ...VALID_VALUES, deathLineChars: 0.5 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"deathLineChars"');
    });
  });

  it('accepts a treatment price of zero', () => {
    withConfigFile({ ...VALID_VALUES, ordinaryTreatmentPrice: 0, completeTreatmentPrice: 0 }, (root) => {
      const config = loadAppConfig({ rootDir: root, env: VALID_ENV });
      expect(config.values.ordinaryTreatmentPrice).toBe(0);
      expect(config.values.completeTreatmentPrice).toBe(0);
    });
  });

  it('lists every missing or ill-typed number at once', () => {
    withConfigFile({ satietyDecayPerSecond: 0.05, satietyMax: 'lots', consolePort: 700000 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"satietyMax"');
      expect(message).toContain('"initialBalance"');
      expect(message).toContain('"exchangeRate"');
      expect(message).toContain('"consolePort"');
    });
  });

  it('refuses an initial satiety above the ceiling', () => {
    withConfigFile({ ...VALID_VALUES, initialSatiety: 200 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('initialSatiety');
    });
  });

  it('refuses a non-positive exchange rate but accepts null', () => {
    withConfigFile({ ...VALID_VALUES, exchangeRate: 0 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('exchangeRate');
    });
    withConfigFile({ ...VALID_VALUES, exchangeRate: 7.4 }, (root) => {
      const config = loadAppConfig({ rootDir: root, env: VALID_ENV });
      expect(config.values.exchangeRate).toBe(7.4);
    });
  });

  it('refuses a config file that is missing or not JSON', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conservatory-config-'));
    try {
      const missing = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(missing).toContain('config file not found');
      writeFileSync(path.join(root, CONFIG_FILE_NAME), '{ not json', 'utf8');
      const broken = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(broken).toContain('not valid JSON');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a missing or ill-typed tool-call cap and request timeout', () => {
    const withoutBoth: Record<string, unknown> = { ...VALID_VALUES };
    delete withoutBoth['maxToolCallsPerRound'];
    delete withoutBoth['modelRequestTimeoutSeconds'];
    withConfigFile(withoutBoth, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"maxToolCallsPerRound"');
      expect(message).toContain('"modelRequestTimeoutSeconds"');
    });
    withConfigFile({ ...VALID_VALUES, maxToolCallsPerRound: 0 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"maxToolCallsPerRound" must be at least 1');
    });
    withConfigFile({ ...VALID_VALUES, maxToolCallsPerRound: 2.5 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"maxToolCallsPerRound" must be an integer');
    });
    withConfigFile({ ...VALID_VALUES, modelRequestTimeoutSeconds: 0 }, (root) => {
      const message = configError(() => loadAppConfig({ rootDir: root, env: VALID_ENV }));
      expect(message).toContain('"modelRequestTimeoutSeconds" must be greater than 0');
    });
  });

  it('requires every model environment variable, and names the missing ones', () => {
    withConfigFile(VALID_VALUES, (root) => {
      const message = configError(() =>
        loadAppConfig({
          rootDir: root,
          env: { AGENT_MODEL_BASE_URL: 'http://x', AGENT_MODEL_API_KEY: 'k' },
        }),
      );
      expect(message).toContain('AGENT_MODEL_NAME');
      expect(message).toContain('MEMORY_MODEL_BASE_URL');
      expect(message).toContain('MEMORY_MODEL_API_KEY');
      expect(message).toContain('MEMORY_MODEL_NAME');
    });
  });
});
