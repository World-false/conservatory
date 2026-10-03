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
  roundContextCapTokens: 60000,
  taskClaimTimeoutHours: 24,
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
  it('reads the committed config file and leaves the exchange rate unset', () => {
    const config = loadAppConfig({ rootDir: process.cwd(), env: VALID_ENV });
    expect(config.values.satietyDecayPerSecond).toBe(0.05);
    expect(config.values.satietyMax).toBe(100);
    expect(config.values.mealPrice).toBe(15);
    expect(config.values.satietyPerMeal).toBe(25);
    expect(config.values.heartbeatSeconds).toBe(300);
    expect(config.values.maxSlots).toBe(1);
    expect(config.values.memoryCapChars).toBe(8000);
    expect(config.values.roundContextCapTokens).toBe(60000);
    expect(config.values.taskClaimTimeoutHours).toBe(24);
    expect(config.values.consolePort).toBe(4317);
    expect(config.values.exchangeRate).toBeNull();
    expect(config.paths.ledgerPath).toBe(path.join(process.cwd(), 'SUPERVISOR', 'ledger.db'));
    expect(config.paths.blackboxDir).toBe(path.join(process.cwd(), 'SUPERVISOR', 'blackbox'));
    expect(config.models.agent.model).toBe('agent-model');
    expect(config.models.memory.model).toBe('memory-model');
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
