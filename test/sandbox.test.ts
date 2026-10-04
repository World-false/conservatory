import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAppConfig } from '../src/config';
import { executeSandboxedCommand } from '../src/organs/sandbox';
import {
  createSandboxPolicyStore,
  DEFAULT_SANDBOX_POLICY,
  persistSandboxPolicy,
  validateSandboxPatch,
  type SandboxPolicyConfig,
} from '../src/organs/sandbox/policy';

/** A complete, valid config file body, so the loader can read it back. */
const FULL_CONFIG: Record<string, unknown> = {
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

/**
 * These tests run real Windows processes under the real restricted token, so
 * every assertion here is the operating system's answer rather than a check
 * this harness performs. They need no elevation: the ACL edits they make are
 * ordinary DACL edits on directories the test itself owns.
 */
const onWindows = process.platform === 'win32';
const WINDOWS_ONLY = 60_000;

interface Fixture {
  root: string;
  agentHome: string;
  notebook: string;
  memory: string;
  supervisorDir: string;
  ledgerFile: string;
  otherAgentHome: string;
  otherNotebookFile: string;
  cleanup(): void;
}

const fixtures: Fixture[] = [];

function removeQuietly(target: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      return;
    } catch {
      /* a lingering handle on Windows; the temp directory may stay behind */
    }
  }
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'conservatory-sandbox-'));
  const agentHome = path.join(root, 'AGENTS', 'agent_01');
  const notebook = path.join(agentHome, 'notebook');
  const supervisorDir = path.join(root, 'SUPERVISOR');
  const otherAgentHome = path.join(root, 'AGENTS', 'agent_02');
  mkdirSync(notebook, { recursive: true });
  mkdirSync(supervisorDir, { recursive: true });
  mkdirSync(path.join(otherAgentHome, 'notebook'), { recursive: true });
  const memory = path.join(agentHome, 'MEMORY');
  const ledgerFile = path.join(supervisorDir, 'ledger.db');
  const otherNotebookFile = path.join(otherAgentHome, 'notebook', 'theirs.txt');
  writeFileSync(memory, 'I am agent 01.\n', 'utf8');
  writeFileSync(ledgerFile, 'the ledger secret\n', 'utf8');
  writeFileSync(otherNotebookFile, 'another agent private\n', 'utf8');
  const fixture: Fixture = {
    root,
    agentHome,
    notebook,
    memory,
    supervisorDir,
    ledgerFile,
    otherAgentHome,
    otherNotebookFile,
    cleanup: () => {
      removeQuietly(root);
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});

interface RunOverrides {
  shell?: 'pwsh' | 'cmd';
  readMode?: 'blacklist' | 'whitelist';
  readWhitelist?: string[];
  readBlacklist?: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
  whitelistRoot?: string;
}

function run(fixture: Fixture, command: string, overrides: RunOverrides = {}) {
  return executeSandboxedCommand({
    command,
    cwd: fixture.notebook,
    writableDirs: [fixture.notebook],
    readMode: overrides.readMode ?? 'blacklist',
    readBlacklist: overrides.readBlacklist ?? [fixture.supervisorDir, fixture.otherAgentHome],
    // The production resolver always names the agent's own home here, which is
    // what makes its MEMORY readable while staying unwritable.
    readWhitelist: overrides.readWhitelist ?? [fixture.agentHome],
    readOnlyFiles: [fixture.memory],
    timeoutMs: overrides.timeoutMs ?? 30_000,
    ...(overrides.maxOutputChars === undefined ? {} : { maxOutputChars: overrides.maxOutputChars }),
    ...(overrides.whitelistRoot === undefined ? {} : { whitelistRoot: overrides.whitelistRoot }),
    shell: overrides.shell ?? 'cmd',
  });
}

describe.skipIf(!onWindows)('the command sandbox', () => {
  it(
    'runs cmd.exe and reports its output and exit code',
    async () => {
      const fixture = createFixture();
      const result = await run(fixture, 'echo hello-from-cmd');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello-from-cmd');
      expect(result.stderr).toBe('');
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    },
    WINDOWS_ONLY,
  );

  it(
    'runs pwsh and reports its output and exit code',
    async () => {
      const fixture = createFixture();
      const result = await run(fixture, 'Write-Output "hello-from-pwsh"', { shell: 'pwsh' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello-from-pwsh');
    },
    WINDOWS_ONLY,
  );

  it(
    'runs the command at the supervisor own integrity level, never lowered to Low',
    async () => {
      const fixture = createFixture();
      const result = await run(fixture, 'whoami /groups | findstr /i "Mandatory"');
      const firstLine = result.stdout.trim().split('\n')[0] ?? '';
      expect(firstLine).toContain('Mandatory Label');
      expect(firstLine).not.toContain('Low Mandatory Level');
    },
    WINDOWS_ONLY,
  );

  it(
    'reports a non-zero exit code as the command outcome, not as a harness error',
    async () => {
      const fixture = createFixture();
      const result = await run(fixture, 'exit /b 3');
      expect(result.exitCode).toBe(3);
      expect(result.timedOut).toBe(false);
    },
    WINDOWS_ONLY,
  );

  it(
    'truncates oversized output at the configured cap',
    async () => {
      const fixture = createFixture();
      const result = await run(fixture, 'for /l %i in (1,1,400) do @echo 0123456789', { maxOutputChars: 200 });
      expect(result.stdout.length).toBeLessThan(400);
      expect(result.stdout).toContain('truncated');
    },
    WINDOWS_ONLY,
  );

  it(
    'lets the command write inside its own notebook',
    async () => {
      const fixture = createFixture();
      const result = await run(fixture, 'echo written-by-agent > made.txt');
      expect(result.exitCode).toBe(0);
      const written = path.join(fixture.notebook, 'made.txt');
      expect(existsSync(written)).toBe(true);
      expect(readFileSync(written, 'utf8')).toContain('written-by-agent');
    },
    WINDOWS_ONLY,
  );

  it(
    'refuses a write into SUPERVISOR/ at the kernel, leaving the ledger untouched',
    async () => {
      const fixture = createFixture();
      const result = await run(fixture, `echo hacked > "${fixture.ledgerFile}"`);
      expect(readFileSync(fixture.ledgerFile, 'utf8')).toBe('the ledger secret\n');
      expect(result.stdout).not.toContain('hacked');
      expect(result.stderr.toLowerCase()).toContain('denied');
    },
    WINDOWS_ONLY,
  );

  it(
    'refuses a write into the system directory at the kernel',
    async () => {
      const fixture = createFixture();
      const target = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'conservatory-escape.txt');
      const result = await run(fixture, `echo escaped > "${target}"`);
      expect(existsSync(target)).toBe(false);
      expect(result.stderr.toLowerCase()).toContain('denied');
    },
    WINDOWS_ONLY,
  );

  it(
    'refuses to overwrite MEMORY, and MEMORY stays readable',
    async () => {
      const fixture = createFixture();
      const overwrite = await run(fixture, `echo rewritten > "${fixture.memory}"`);
      expect(readFileSync(fixture.memory, 'utf8')).toBe('I am agent 01.\n');
      expect(overwrite.stderr.toLowerCase()).toContain('denied');

      const read = await run(fixture, `type "${fixture.memory}"`);
      expect(read.exitCode).toBe(0);
      expect(read.stdout).toContain('I am agent 01.');
    },
    WINDOWS_ONLY,
  );

  it(
    'refuses to read SUPERVISOR/ and another agent home',
    async () => {
      const fixture = createFixture();
      const ledger = await run(fixture, `type "${fixture.ledgerFile}"`);
      expect(ledger.stdout).not.toContain('the ledger secret');
      expect(ledger.stderr.toLowerCase()).toContain('denied');

      const other = await run(fixture, `type "${fixture.otherNotebookFile}"`);
      expect(other.stdout).not.toContain('another agent private');
      expect(other.stderr.toLowerCase()).toContain('denied');
    },
    WINDOWS_ONLY,
  );

  it(
    'refuses to list a blacklisted directory',
    async () => {
      const fixture = createFixture();
      const result = await run(fixture, `dir "${fixture.supervisorDir}"`);
      expect(result.stdout).not.toContain('ledger.db');
      expect(result.stderr.toLowerCase()).toContain('denied');
    },
    WINDOWS_ONLY,
  );

  it(
    'in whitelist mode reads only what the whitelist names',
    async () => {
      const fixture = createFixture();
      const agentsDir = path.join(fixture.root, 'AGENTS');
      const allowed = [fixture.agentHome, fixture.notebook];
      const inside = await run(fixture, `type "${fixture.memory}"`, {
        readMode: 'whitelist',
        readWhitelist: allowed,
        readBlacklist: [],
        whitelistRoot: agentsDir,
      });
      expect(inside.stdout).toContain('I am agent 01.');

      const outside = await run(fixture, `type "${fixture.otherNotebookFile}"`, {
        readMode: 'whitelist',
        readWhitelist: allowed,
        readBlacklist: [],
        whitelistRoot: agentsDir,
      });
      expect(outside.stdout).not.toContain('another agent private');
      expect(outside.stderr.toLowerCase()).toContain('denied');
    },
    WINDOWS_ONLY,
  );

  it(
    'kills a command that overruns its timeout and says so',
    async () => {
      const fixture = createFixture();
      const started = Date.now();
      const result = await run(fixture, 'ping -n 30 127.0.0.1 > nul', { timeoutMs: 1_500 });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(20_000);
    },
    WINDOWS_ONLY,
  );

  it(
    'kills grandchildren too, so nothing escapes the job object',
    async () => {
      const fixture = createFixture();
      const escaped = path.join(fixture.notebook, 'escaped.txt');
      const result = await run(
        fixture,
        `start /b cmd /c "ping -n 6 127.0.0.1 > nul & echo late > "${escaped}"" & ping -n 30 127.0.0.1 > nul`,
        { timeoutMs: 2_000 },
      );
      expect(result.timedOut).toBe(true);
      // The grandchild would write this about four seconds after the kill.
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      expect(existsSync(escaped)).toBe(false);
    },
    90_000,
  );
});

describe('the sandbox policy', () => {
  it('validates a console payload field by field', () => {
    expect(validateSandboxPatch({ readMode: 'nope' })).toEqual({ ok: false, error: 'invalid_read_mode' });
    expect(validateSandboxPatch({ readBlacklist: 'not-a-list' })).toEqual({
      ok: false,
      error: 'invalid_path_list',
    });
    expect(validateSandboxPatch({ readBlacklist: ['relative\\path'] })).toEqual({
      ok: false,
      error: 'invalid_path_list',
    });
    expect(validateSandboxPatch({ commandTimeoutSeconds: 0 })).toEqual({
      ok: false,
      error: 'invalid_command_timeout',
    });
    expect(validateSandboxPatch({ maxOutputChars: 1.5 })).toEqual({ ok: false, error: 'invalid_max_output' });
    expect(validateSandboxPatch({})).toEqual({ ok: false, error: 'empty_sandbox_patch' });
    const accepted = validateSandboxPatch({ readMode: 'whitelist', commandTimeoutSeconds: 5 });
    expect(accepted.ok).toBe(true);
  });

  it('resolves the locked entries from the body, not from operator taste', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conservatory-policy-'));
    try {
      const agentsDir = path.join(root, 'AGENTS');
      const supervisorDir = path.join(root, 'SUPERVISOR');
      const home = path.join(agentsDir, 'agent_01');
      const notebook = path.join(home, 'notebook');
      const memory = path.join(home, 'MEMORY');
      const otherHome = path.join(agentsDir, 'agent_02');
      const store = createSandboxPolicyStore({
        configPath: path.join(root, 'conservatory.config.json'),
        agentsDir,
        supervisorDir,
        listAgentHomes: () => [home, otherHome],
        initial: { ...DEFAULT_SANDBOX_POLICY },
        persist: () => undefined,
      });
      const resolved = store.resolve({ name: 'agent_01', homeDir: home, notebookDir: notebook, memoryPath: memory });
      expect(resolved.readBlacklist).toContain(supervisorDir);
      expect(resolved.readBlacklist).toContain(otherHome);
      expect(resolved.readBlacklist).not.toContain(home);
      expect(resolved.writableDirs).toContain(notebook);
      expect(resolved.readOnlyFiles).toEqual([memory]);
      expect(resolved.whitelistRoot).toBe(agentsDir);

      const view = store.view();
      expect(view.lockedReadBlacklist).toContain(supervisorDir);
      expect(view.lockedReadBlacklist).toContain(home);
      expect(view.lockedWritableDirs).toContain(path.join(otherHome, 'notebook'));
    } finally {
      removeQuietly(root);
    }
  });

  it('a configured blacklist entry never swallows the agent own body', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conservatory-policy-'));
    try {
      const agentsDir = path.join(root, 'AGENTS');
      const supervisorDir = path.join(root, 'SUPERVISOR');
      const home = path.join(agentsDir, 'agent_01');
      const notebook = path.join(home, 'notebook');
      const memory = path.join(home, 'MEMORY');
      const store = createSandboxPolicyStore({
        configPath: path.join(root, 'conservatory.config.json'),
        agentsDir,
        supervisorDir,
        listAgentHomes: () => [home],
        initial: { ...DEFAULT_SANDBOX_POLICY, readBlacklist: [home] },
        persist: () => undefined,
      });
      const resolved = store.resolve({ name: 'agent_01', homeDir: home, notebookDir: notebook, memoryPath: memory });
      expect(resolved.readBlacklist).not.toContain(home);
    } finally {
      removeQuietly(root);
    }
  });

  it('persists an update into the config file and reads it back', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conservatory-policy-'));
    try {
      const configPath = path.join(root, 'conservatory.config.json');
      writeFileSync(configPath, `${JSON.stringify(FULL_CONFIG, null, 2)}\n`, 'utf8');
      const store = createSandboxPolicyStore({
        configPath,
        agentsDir: path.join(root, 'AGENTS'),
        supervisorDir: path.join(root, 'SUPERVISOR'),
        listAgentHomes: () => [],
        initial: { ...DEFAULT_SANDBOX_POLICY },
      });
      const updated = store.update({
        readMode: 'whitelist',
        readWhitelist: [path.join(root, 'docs')],
        writableDirs: [path.join(root, 'shared')],
        commandTimeoutSeconds: 12,
        maxOutputChars: 500,
      });
      expect(updated.ok).toBe(true);
      expect(store.view().readMode).toBe('whitelist');
      expect(store.view().commandTimeoutSeconds).toBe(12);

      const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(written['satietyMax']).toBe(100);
      expect(written['consolePort']).toBe(4317);
      expect(written['sandbox']).toMatchObject({
        readMode: 'whitelist',
        commandTimeoutSeconds: 12,
        maxOutputChars: 500,
      });

      // The supervisor reads the same file back through the ordinary loader.
      const loaded = loadAppConfig({
        rootDir: root,
        configFile: configPath,
        env: {
          AGENT_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
          AGENT_MODEL_API_KEY: 'k',
          AGENT_MODEL_NAME: 'm',
          MEMORY_MODEL_BASE_URL: 'http://127.0.0.1:1/v1',
          MEMORY_MODEL_API_KEY: 'k',
          MEMORY_MODEL_NAME: 'm',
        },
      });
      expect(loaded.sandbox).toEqual({
        readMode: 'whitelist',
        readBlacklist: [],
        readWhitelist: [path.join(root, 'docs')],
        writableDirs: [path.join(root, 'shared')],
        commandTimeoutSeconds: 12,
        maxOutputChars: 500,
      });
    } finally {
      removeQuietly(root);
    }
  });

  it('leaves the in-memory policy alone when the file cannot be written', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conservatory-policy-'));
    try {
      const store = createSandboxPolicyStore({
        configPath: path.join(root, 'missing', 'conservatory.config.json'),
        agentsDir: path.join(root, 'AGENTS'),
        supervisorDir: path.join(root, 'SUPERVISOR'),
        listAgentHomes: () => [],
        initial: { ...DEFAULT_SANDBOX_POLICY },
      });
      const result = store.update({ readMode: 'whitelist' });
      expect(result).toEqual({ ok: false, error: 'sandbox_config_write_failed' });
      expect(store.view().readMode).toBe('blacklist');
    } finally {
      removeQuietly(root);
    }
  });

  it('falls back to the documented defaults when the block is absent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'conservatory-policy-'));
    try {
      const configPath = path.join(root, 'conservatory.config.json');
      writeFileSync(configPath, `${JSON.stringify({ satietyMax: 100 }, null, 2)}\n`, 'utf8');
      const policy: SandboxPolicyConfig = {
        ...DEFAULT_SANDBOX_POLICY,
        readBlacklist: [path.join(root, 'x')],
      };
      persistSandboxPolicy(configPath, policy);
      const written = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      expect(written['sandbox']).toEqual(policy);
    } finally {
      removeQuietly(root);
    }
  });
});
