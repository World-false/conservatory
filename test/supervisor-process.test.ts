import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentProcess } from '../src/supervisor/main';

/**
 * The tsx loader the supervisor itself passes to every worker, resolved from
 * the project root. It is a real loader URL (`--import` rejects a bare path),
 * so a test worker comes up exactly as a real one does.
 */
const projectRequire = createRequire(path.join(process.cwd(), 'package.json'));
const LOADER_URL = pathToFileURL(projectRequire.resolve('tsx')).href;

/** The supervisor's own problem channel, kept quiet but observable. */
function fakeDeps(workerPath: string, homeDir: string, problems: string[]) {
  return {
    workerPath,
    loaderUrl: LOADER_URL,
    homeDir,
    resolveModel: () => ({
      settings: { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', model: 'test-model' },
      modelName: 'test-model',
    }),
    roundContextCapTokens: 60000,
    maxToolCallsPerRound: 50,
    modelRequestTimeoutSeconds: 120,
    onProblem: (_agent: string, message: string) => {
      problems.push(message);
    },
  };
}

/** Waits for a condition the child produces, without depending on real time. */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe('AgentProcess process lifecycle', () => {
  it('fork failure does not hang ensureStarted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conservatory-fork-fail-'));
    let process0: AgentProcess | null = null;
    try {
      // A worker path that does not exist is resolved by the child after it
      // spawns, so this reports through 'exit' rather than 'error'. It is the
      // shape in the bug report; the test below covers the harder 'error' case.
      const missing = path.join(dir, 'does-not-exist-worker.ts');
      process0 = new AgentProcess('tester', fakeDeps(missing, dir, []));

      await Promise.race([
        process0.ensureStarted(),
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('ensureStarted hung'));
          }, 5000);
        }),
      ]);

      expect((process0 as unknown as { child: unknown }).child).toBeNull();
    } finally {
      const child = (process0 as unknown as { child?: { kill?: () => void } } | null)?.child;
      child?.kill?.();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('spawn failure with no exit event does not hang ensureStarted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conservatory-spawn-fail-'));
    let process0: AgentProcess | null = null;
    try {
      // A worker that exists, so the only thing that can fail is the spawn of
      // the process itself (cwd). That failure arrives as 'error' + 'close'
      // and never as 'exit', which is the case that used to hang forever.
      const workerPath = path.join(dir, 'worker.mjs');
      writeFileSync(workerPath, "process.send({ type: 'ready' });\n");
      const homeDir = path.join(dir, 'missing-home');

      const problems: string[] = [];
      process0 = new AgentProcess('tester', fakeDeps(workerPath, homeDir, problems));

      await Promise.race([
        process0.ensureStarted(),
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('ensureStarted hung'));
          }, 5000);
        }),
      ]);

      expect((process0 as unknown as { child: unknown }).child).toBeNull();
      expect(problems.some((message) => message.includes('agent process error'))).toBe(true);
    } finally {
      const child = (process0 as unknown as { child?: { kill?: () => void } } | null)?.child;
      child?.kill?.();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('child exit mid-round settles the round as model_error', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'conservatory-exit-round-'));
    let agentProcess: AgentProcess | null = null;
    try {
      const workerPath = path.join(dir, 'worker.mjs');
      writeFileSync(workerPath, "process.send({ type: 'ready' });\nsetTimeout(() => process.exit(1), 20);\n");

      const collected: unknown[] = [];
      agentProcess = new AgentProcess('tester', fakeDeps(workerPath, dir, []));
      // A round already in flight when the process dies.
      (agentProcess as unknown as { activeRoundId: number | null }).activeRoundId = 7;
      (agentProcess as unknown as { handler: ((message: unknown) => void) | null }).handler = (message: unknown) => {
        collected.push(message);
      };

      await agentProcess.ensureStarted();
      await waitFor(() => collected.length > 0, 3000);

      expect(collected).toHaveLength(1);
      expect(collected[0]).toMatchObject({
        type: 'round_end',
        roundId: 7,
        endReason: 'model_error',
        finalReply: null,
      });
      expect((collected[0] as { error: string | null }).error).not.toBeNull();
      expect((agentProcess as unknown as { activeRoundId: number | null }).activeRoundId).toBeNull();
    } finally {
      const live = agentProcess as unknown as {
        stop?: () => void;
        child?: { kill?: () => void } | null;
      } | null;
      live?.stop?.();
      live?.child?.kill?.();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
