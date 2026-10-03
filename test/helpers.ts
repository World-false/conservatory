import { mkdtempSync, rmSync } from 'node:fs';
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

export function testValues(overrides: Partial<ConservatoryValues> = {}): ConservatoryValues {
  return {
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

export function textResponse(
  content: string,
  usage: TokenUsage | null = { promptTokens: 100, completionTokens: 20 },
): ChatResponse {
  return { message: { role: 'assistant', content }, usage };
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
 * bypasses the step-1 slot ceiling on purpose; nothing here touches files.
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
