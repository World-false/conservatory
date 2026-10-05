import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ChildToParentMessage,
  ParentToChildMessage,
  SerializedMessage,
  TokenUsage,
  ToolSchema,
} from '../src/agent/ipc';
import { runModelLoop, type ToolOutcome } from '../src/agent/worker';
import { createRuntimePaths, ensureRuntimeDirs, type ConservatoryValues, type RuntimePaths } from '../src/config';
import type { ChatRequest, ChatResponse, ModelClient } from '../src/model/client';
import { Blackbox } from '../src/organs/blackbox';
import type { AgentRecord } from '../src/organs/ledger';
import { Ledger } from '../src/organs/ledger';
import { createAgent } from '../src/organs/population';
import { createPromptLibrary, type PromptLibrary, type PromptLoadMode } from '../src/organs/prompts';
import {
  createModelConfigStore,
  type ModelConfigStore,
  type ModelsConfigData,
} from '../src/organs/models/store';
import {
  createSandboxPolicyStore,
  DEFAULT_SANDBOX_POLICY,
  type SandboxPolicyStore,
} from '../src/organs/sandbox/policy';
import type { WorkerTransport } from '../src/supervisor/round';

/** Every test runs on a fake clock, so nothing depends on real time. */
export class FakeClock {
  private current: number;

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  readonly now = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }

  set(at: number): void {
    this.current = at;
  }
}

export function testValues(overrides: Partial<ConservatoryValues> = {}): ConservatoryValues {  return {
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
    ...overrides,
  };
}

/**
 * Windows keeps a database file handle alive for a moment after close, so a
 * removal can fail with EPERM even though everything is closed. A few retries
 * settle it; a leftover temp directory must never fail a test.
 */
function removeRuntimeDir(root: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      return;
    } catch (error) {
      if (attempt === 4) {
        return;
      }
      // A short synchronous pause; nothing in these tests is timing-sensitive.
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* wait out the lingering file handle */
      }
    }
  }
}

export interface Harness {
  root: string;
  paths: RuntimePaths;
  ledger: Ledger;
  blackbox: Blackbox;
  clock: FakeClock;
  values: ConservatoryValues;
  cleanup(): void;
}

export function createHarness(options: { values?: Partial<ConservatoryValues>; clock?: FakeClock } = {}): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'conservatory-test-'));
  const paths = createRuntimePaths(
    root,
    path.join(root, 'conservatory.config.json'),
    path.join(root, '.env'),
  );
  ensureRuntimeDirs(paths);
  const ledger = new Ledger(paths.ledgerPath);
  const blackbox = new Blackbox(paths.blackboxDir);
  const clock = options.clock ?? new FakeClock();
  return {
    root,
    paths,
    ledger,
    blackbox,
    clock,
    values: testValues(options.values),
    cleanup(): void {
      // A test may close the ledger itself to simulate a supervisor restart;
      // cleanup stays safe either way.
      try {
        ledger.close();
      } catch (error) {
        /* already closed */
      }
      removeRuntimeDir(root);
    },
  };
}

/**
 * The real sandbox policy store with persistence captured in memory, so a test
 * never rewrites a config file. Validation, resolution and the locked built-in
 * entries all run exactly as they do in the supervisor.
 */
export function testSandboxPolicy(h: Harness, initial = DEFAULT_SANDBOX_POLICY): SandboxPolicyStore {
  return createSandboxPolicyStore({
    configPath: h.paths.configPath,
    agentsDir: h.paths.agentsDir,
    supervisorDir: h.paths.supervisorDir,
    listAgentHomes: () => h.ledger.listAgents().map((agent) => path.join(h.paths.agentsDir, agent.name)),
    initial: { ...initial },
    persist: () => undefined,
  });
}

/** The `.env` models a test starts from, unless it says otherwise. */
export const TEST_ENV_MODELS = {
  agent: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'agent-key', model: 'agent-model' },
  memory: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'memory-key', model: 'memory-model' },
};

/**
 * A real model roster with its file write captured instead of performed, so a
 * test never rewrites conservatory.config.json. Validation, seeding from .env
 * and the "provider still in use" refusal all run exactly as in production.
 */
export function testModelStore(
  h: Harness,
  options: {
    data?: ModelsConfigData;
    listBoundAgents?: () => { agent: string; providerId: string }[];
  } = {},
): { store: ModelConfigStore; written: ModelsConfigData[] } {
  const written: ModelsConfigData[] = [];
  const store = createModelConfigStore({
    configPath: h.paths.configPath,
    env: TEST_ENV_MODELS,
    readPersisted: () => options.data ?? null,
    persist: (next) => {
      written.push(next);
    },
    listBoundAgents: options.listBoundAgents,
  });
  return { store, written };
}

/** One provider, one model: the roster a simple test needs. */
export function simpleModelsData(overrides: Partial<ModelsConfigData> = {}): ModelsConfigData {
  return {
    defaultAgentProviderId: 'main',
    defaultAgentModel: 'agent-model',
    defaultMemoryProviderId: 'main',
    defaultMemoryModel: 'memory-model',
    providers: [
      {
        id: 'main',
        name: '主提供商',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'main-key',
        models: ['agent-model', 'memory-model'],
      },
    ],
    ...overrides,
  };
}

/** Two providers, for the tests that care which one a model belongs to. */
export function twoProviderModels(): ModelsConfigData {
  return {
    defaultAgentProviderId: 'openai',
    defaultAgentModel: 'gpt-4o',
    defaultMemoryProviderId: 'openai',
    defaultMemoryModel: 'gpt-4o',
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
}

export function textResponse(
  content: string,
  usage: TokenUsage | null = { promptTokens: 100, completionTokens: 20 },
): ChatResponse {  return { message: { role: 'assistant', content }, usage };
}

export function toolCallResponse(
  calls: { id: string; name: string; args: unknown }[],
  usage: TokenUsage | null = { promptTokens: 100, completionTokens: 20 },
): ChatResponse {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.name,
        argumentsJson: JSON.stringify(call.args),
      })),
    },
    usage,
  };
}

/** A model whose answers are written in advance; it never touches the network. */
export class ScriptedModelClient implements ModelClient {
  private readonly responses: ChatResponse[];
  readonly requests: ChatRequest[] = [];

  constructor(responses: ChatResponse[]) {
    this.responses = [...responses];
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error('the scripted model ran out of responses');
    }
    return next;
  }
}

type WakeMessage = Extract<ParentToChildMessage, { type: 'wake' }>;

/**
 * Stands in for the forked agent process inside the test: it runs the real
 * model loop, but the round trip goes through plain function calls instead of
 * a child process, and the model is scripted.
 */
export class InProcessWorker implements WorkerTransport {
  private readonly client: ModelClient;
  private handler: ((message: ChildToParentMessage) => void) | null = null;
  private cap = 0;
  private maxToolCalls = 0;
  private readonly pending = new Map<string, (outcome: ToolOutcome) => void>();
  readonly sent: ParentToChildMessage[] = [];

  constructor(client: ModelClient) {
    this.client = client;
  }

  send(message: ParentToChildMessage): void {
    this.sent.push(message);
    if (message.type === 'init') {
      this.cap = message.roundContextCapTokens;
      this.maxToolCalls = message.maxToolCallsPerRound;
      return;
    }
    if (message.type === 'wake') {
      void this.runRound(message);
      return;
    }
    if (message.type === 'tool_result') {
      const resolve = this.pending.get(message.callId);
      if (resolve === undefined) {
        throw new Error(`the worker got a result for an unknown call: ${message.callId}`);
      }
      this.pending.delete(message.callId);
      resolve({ content: message.content, isError: message.isError });
    }
  }

  onMessage(handler: (message: ChildToParentMessage) => void): void {
    this.handler = handler;
  }

  private emit(message: ChildToParentMessage): void {
    if (this.handler === null) {
      throw new Error('the round coordinator is not listening');
    }
    this.handler(message);
  }

  private async runRound(wake: WakeMessage): Promise<void> {
    const tools: readonly ToolSchema[] = wake.tools;
    await runModelLoop({
      client: this.client,
      system: wake.system,
      user: wake.user,
      tools,
      roundContextCapTokens: this.cap,
      maxToolCallsPerRound: this.maxToolCalls,
      requestTool: (callId, name, argumentsJson) =>
        new Promise<ToolOutcome>((resolve) => {
          this.pending.set(callId, resolve);
          this.emit({ type: 'tool_call', roundId: wake.roundId, callId, name, argumentsJson });
        }),
      emit: (event) => {
        if (event.type === 'assistant_message') {
          const message: SerializedMessage = event.message;
          this.emit({ type: 'assistant_message', roundId: wake.roundId, message });
          return;
        }
        if (event.type === 'usage') {
          this.emit({ type: 'usage', roundId: wake.roundId, usage: event.usage });
          return;
        }
        this.emit({
          type: 'round_end',
          roundId: wake.roundId,
          endReason: event.endReason,
          finalReply: event.finalReply,
          error: event.error,
        });
      },
    });
  }
}

/** Header-only MEMORY response, used where the round's memory write is noise. */export function memoryResponse(name: string, bornAt: number, extra = ''): ChatResponse {
  const header = `Name: ${name}\nBorn: ${new Date(bornAt).toISOString()}`;
  const content = extra.trim() === '' ? header : `${header}\n${extra}`;
  return textResponse(content, { promptTokens: 200, completionTokens: 40 });
}

/** A real birth through the population organ, including files and ledger rows. */
export function birthAgent(h: Harness, name = 'ada', model = 'test-model'): AgentRecord {
  const result = createAgent({
    name,
    model,
    now: h.clock.now(),
    ledger: h.ledger,
    values: h.values,
    paths: h.paths,
  });
  if (!result.ok) {
    throw new Error(`could not create the agent: ${result.code}`);
  }
  return result.agent;
}

/**
 * A ledger-only agent, for state machine tests that need a second party. It
 * bypasses the slot ceiling and writes no files; use `birthAgent` when the slot
 * count itself is what the test is about.
 */
export function insertAgentRow(h: Harness, name: string): AgentRecord {
  const record: AgentRecord = { name, bornAt: h.clock.now(), model: 'test-model', status: 'alive' };
  h.ledger.createAgent(record);
  h.ledger.setSatietyAnchor(name, h.values.initialSatiety, h.clock.now());
  h.ledger.appendBalanceEvent(name, h.values.initialBalance, 'genesis', null, h.clock.now());
  return record;
}

/**
 * An in-process worker that has already been initialized, the way the
 * supervisor initializes a real forked worker before the first wake.
 */
export function initWorker(h: Harness, model: ModelClient): InProcessWorker {
  const worker = new InProcessWorker(model);
  worker.send({
    type: 'init',
    model: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key', model: 'test-model' },
    roundContextCapTokens: h.values.roundContextCapTokens,
    maxToolCallsPerRound: h.values.maxToolCallsPerRound,
    modelRequestTimeoutSeconds: h.values.modelRequestTimeoutSeconds,
  });
  return worker;
}

/**
 * The prompt templates of a test conservatory. The harness root starts empty,
 * so unless a test writes prompts/ the built-in fallbacks are what get used.
 */
export function testPrompts(h: Harness, mode: PromptLoadMode = 'hot'): PromptLibrary {
  return createPromptLibrary(h.paths, mode);
}

/** Writes prompt files into the harness root, keyed by file name. */
export function writePrompts(h: Harness, files: Record<string, string>): string {
  mkdirSync(h.paths.promptsDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(h.paths.promptsDir, name), text, 'utf8');
  }
  return h.paths.promptsDir;
}
