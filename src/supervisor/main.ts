import { randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildToParentMessage, ParentToChildMessage } from '../agent/ipc';
import {
  ConfigError,
  agentHomeDir,
  ensureRuntimeDirs,
  isReasoningEffort,
  loadAppConfig,
  persistConservatoryValues,
  validateValuesPatch,
  type AppConfig,
  type ConservatoryValues,
  type ModelSettings,
  type ReasoningEffort,
} from '../config';
import { createConsoleServer, type ConsoleNotice, type RuntimeInfo } from '../console/server';
import { OpenAICompatibleClient, type ModelClient } from '../model/client';
import { Blackbox } from '../organs/blackbox';
import { treat } from '../organs/clinic';
import { checkDeathLine, die, terminateByOperator, type DeathOutcome } from '../organs/death';
import { eraseAgent, type EraseOutcome } from '../organs/erasure';
import { Heartbeat } from '../organs/heartbeat';
import {
  Ledger,
  PAUSED_SETTING_AGENT,
  type AgentRecord,
  type DeathCause,
  type InterventionKind,
  type TreatmentTier,
} from '../organs/ledger';
import {
  MAX_MEMORY_SESSIONS_PER_ROUND,
  MAX_SANDBOX_REJECTIONS_PER_SESSION,
  readMemoryFile,
  writeMemoryAtomic,
} from '../organs/memory';
import { grantSatiety, readSatiety } from '../organs/metabolism';
import { readModelBinding, writeModelBinding } from '../organs/models/binding';
import { switchAgentModel, type SwitchModelOutcome } from '../organs/models/switch';
import { modelFingerprint, shouldRetireProcess } from '../organs/models/reconcile';
import {
  createModelConfigStore,
  resolveAgentModel,
  type ModelConfigStore,
  type ModelResolution,
  type ResolvedAgentModel,
} from '../organs/models/store';
import {
  createPauseOrgan,
  formatPauseDuration,
  pauseInterventionDetail,
  type PauseOrgan,
} from '../organs/pause';
import {
  createAgent,
  listSlots,
  RoundRegistry,
  wakeLivingAgents,
} from '../organs/population';
import { createPromptLibrary, PromptWarningNotices } from '../organs/prompts';
import { redactAgent } from '../organs/redaction';
import { createSandboxPolicyStore } from '../organs/sandbox/policy';
import { expireClaims } from '../organs/taskboard';
import { RoundCoordinator, type WorkerTransport } from './round';

interface AgentRuntime {
  lastWakeAt: number | null;
  lastRoundAt: number | null;
  lastRoundEndReason: string | null;
  lastError: string | null;
}

function emptyRuntime(): AgentRuntime {
  return { lastWakeAt: null, lastRoundAt: null, lastRoundEndReason: null, lastError: null };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates what a worker sends. A malformed message must not crash the keeper. */
function parseChildMessage(raw: unknown): ChildToParentMessage | null {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') {
    return null;
  }
  const type = raw['type'];
  const roundId = raw['roundId'];
  if (type === 'ready') {
    const pid = raw['pid'];
    return { type: 'ready', pid: typeof pid === 'number' ? pid : -1 };
  }
  if (type === 'assistant_message') {
    const message = raw['message'];
    if (typeof roundId !== 'number' || !isRecord(message) || message['role'] !== 'assistant') {
      return null;
    }
    const content = message['content'];
    if (content !== null && typeof content !== 'string') {
      return null;
    }
    // The model's thinking is carried through untouched. It is validated the
    // same way as the answer, but a malformed one is not worth refusing the
    // whole message over: the answer is what the round depends on, so a bad
    // reasoning field is dropped and the rest is kept.
    const reasoning = message['reasoningContent'];
    return {
      type: 'assistant_message',
      roundId,
      message: {
        role: 'assistant',
        content: content === undefined ? null : content,
        ...(typeof reasoning === 'string' ? { reasoningContent: reasoning } : {}),
      },
    };
  }
  if (type === 'usage') {
    if (typeof roundId !== 'number') {
      return null;
    }
    const usage = raw['usage'];
    if (usage === null || usage === undefined) {
      return { type: 'usage', roundId, usage: null };
    }
    if (!isRecord(usage)) {
      return null;
    }
    const promptTokens = usage['promptTokens'];
    const completionTokens = usage['completionTokens'];
    if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number') {
      return null;
    }
    return { type: 'usage', roundId, usage: { promptTokens, completionTokens } };
  }
  if (type === 'tool_call') {
    const callId = raw['callId'];
    const name = raw['name'];
    const argumentsJson = raw['argumentsJson'];
    if (
      typeof roundId !== 'number' ||
      typeof callId !== 'string' ||
      typeof name !== 'string' ||
      typeof argumentsJson !== 'string'
    ) {
      return null;
    }
    return { type: 'tool_call', roundId, callId, name, argumentsJson };
  }
  if (type === 'round_end') {
    const endReason = raw['endReason'];
    const finalReply = raw['finalReply'];
    const error = raw['error'];
    if (typeof roundId !== 'number' || typeof endReason !== 'string') {
      return null;
    }
    if (finalReply !== null && typeof finalReply !== 'string') {
      return null;
    }
    if (error !== null && typeof error !== 'string') {
      return null;
    }
    if (
      endReason !== 'final' &&
      endReason !== 'context_cap' &&
      endReason !== 'usage_missing' &&
      endReason !== 'iteration_cap' &&
      endReason !== 'model_error'
    ) {
      return null;
    }
    return {
      type: 'round_end',
      roundId,
      endReason,
      finalReply: finalReply === undefined ? null : finalReply,
      error: error === undefined ? null : error,
    };
  }
  if (type === 'worker_log') {
    const level = raw['level'];
    const message = raw['message'];
    if ((level !== 'info' && level !== 'error') || typeof message !== 'string') {
      return null;
    }
    return { type: 'worker_log', level, message };
  }
  return null;
}

interface RoundLimits {
  roundContextCapTokens: number;
  maxToolCallsPerRound: number;
  modelRequestTimeoutSeconds: number;
}

interface AgentProcessDeps {
  workerPath: string;
  loaderUrl: string;
  homeDir: string;
  /**
   * Resolves the brain at the moment the process starts. It is a callback, not
   * a value, because an operator may switch an agent's model between two
   * wake-ups and the next process must come up on the new one.
   */
  resolveModel(): { settings: ModelSettings; modelName: string };
  roundContextCapTokens: number;
  maxToolCallsPerRound: number;
  modelRequestTimeoutSeconds: number;
  /**
   * The round limits as they stand right now, read at the moment the child is
   * initialized rather than captured above. The operator can retune all three
   * in the console, and a process forked before the change must not keep
   * sending the old numbers; the supervisor retires such a process so the next
   * wake-up reads the new ones.
   *
   * Optional so a caller that only ever runs with one fixed set of limits —
   * the process-lifecycle tests — can keep passing the three numbers above.
   */
  limits?(): { roundContextCapTokens: number; maxToolCallsPerRound: number; modelRequestTimeoutSeconds: number };
  onProblem(agent: string, message: string): void;
}

/**
 * One agent, one process. The child's working directory is the agent's home,
 * and it is only ever asked to run the model loop; every tool call comes back
 * over IPC for the supervisor to execute.
 */
export class AgentProcess implements WorkerTransport {
  private readonly deps: AgentProcessDeps;
  private readonly agent: string;
  private child: ChildProcess | null = null;
  private handler: ((message: ChildToParentMessage) => void) | null = null;
  private readyResolve: (() => void) | null = null;
  private activeRoundId: number | null = null;
  /** The model name this process was started with; null before it starts. */
  private startedModel: string | null = null;
  /** The round limits this process was started with; null before it starts. */
  private startedLimits: RoundLimits | null = null;

  constructor(agent: string, deps: AgentProcessDeps) {
    this.agent = agent;
    this.deps = deps;
  }

  /**
   * The model this process is actually running on. The supervisor compares it
   * with the ledger after every round to notice a switch that arrived mid-round.
   */
  currentModel(): string | null {
    return this.startedModel;
  }

  /**
   * The round limits this process is actually running with. The supervisor
   * compares them with the live values after every round, the same way it
   * compares the model, so a limit retuned mid-round is noticed once the round
   * is over instead of cutting it in half.
   */
  currentLimits(): RoundLimits | null {
    return this.startedLimits;
  }

  async ensureStarted(): Promise<void> {
    if (this.child !== null) {
      return;
    }
    const resolved = this.deps.resolveModel();
    // Read here, not at construction: the operator may have retuned the three
    // round limits between the last round and this start.
    const limits =
      this.deps.limits?.() ??
      {
        roundContextCapTokens: this.deps.roundContextCapTokens,
        maxToolCallsPerRound: this.deps.maxToolCallsPerRound,
        modelRequestTimeoutSeconds: this.deps.modelRequestTimeoutSeconds,
      };
    this.startedLimits = limits;
    const child = fork(this.deps.workerPath, [], {
      cwd: this.deps.homeDir,
      execArgv: ['--import', this.deps.loaderUrl],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });
    this.child = child;
    this.startedModel = resolved.modelName;
    child.on('message', (raw: unknown) => {
      this.route(raw);
    });
    child.on('error', (error: Error) => {
      this.deps.onProblem(this.agent, `agent process error: ${error.message}`);
      this.settleFailedStart(child);
    });
    // A fork that never produced a process emits 'error' and then 'close', but
    // not 'exit'. This second guard exists so the ready wait below settles
    // whichever way the failure is reported.
    child.on('close', () => {
      this.settleFailedStart(child);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      const resolve = this.readyResolve;
      this.readyResolve = null;
      if (resolve !== null) {
        this.deps.onProblem(this.agent, 'the agent process exited before it was ready');
        resolve();
      }
      if (this.activeRoundId !== null) {
        const lost = this.activeRoundId;
        // The detail names the code and signal, which `endRoundInFlight` cannot
        // know; everything else about settling lives there.
        this.deps.onProblem(
          this.agent,
          `the agent process exited during round ${lost} (code ${String(code)}, signal ${String(signal)})`,
        );
        this.activeRoundId = null;
        const handler = this.handler;
        if (handler !== null) {
          handler({
            type: 'round_end',
            roundId: lost,
            endReason: 'model_error',
            finalReply: null,
            error: `the agent process exited during round ${lost} (code ${String(code)}, signal ${String(signal)})`,
          });
        }
      }
      this.handler = null;
      this.startedModel = null;
      this.startedLimits = null;
    });

    await new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.send({
      type: 'init',
      model: resolved.settings,
      roundContextCapTokens: limits.roundContextCapTokens,
      maxToolCallsPerRound: limits.maxToolCallsPerRound,
      modelRequestTimeoutSeconds: limits.modelRequestTimeoutSeconds,
    });
  }

  send(message: ParentToChildMessage): void {
    if (message.type === 'wake') {
      this.activeRoundId = message.roundId;
    }
    const child = this.child;
    if (child === null || child.connected !== true) {
      if (this.handler !== null) {
        const roundId = this.activeRoundId ?? 0;
        this.activeRoundId = null;
        this.handler({
          type: 'round_end',
          roundId,
          endReason: 'model_error',
          finalReply: null,
          error: 'the agent process is not running',
        });
      }
      return;
    }
    child.send(message);
  }

  onMessage(handler: (message: ChildToParentMessage) => void): void {
    this.handler = handler;
  }

  /**
   * The process failed to come up. 'error' and 'close' can both arrive, and
   * an 'exit' may follow, so this is written to be idempotent: only the first
   * call for a still-unready child resolves the wait, and the rest do nothing.
   */
  private settleFailedStart(child: ChildProcess): void {
    if (this.readyResolve === null && this.child !== child) {
      return;
    }
    this.child = null;
    this.startedModel = null;
    this.startedLimits = null;
    const resolve = this.readyResolve;
    this.readyResolve = null;
    if (resolve !== null) {
      this.deps.onProblem(this.agent, 'the agent process exited before it was ready');
      resolve();
    }
  }

  /**
   * Stops the agent's process. A round it is in the middle of is ended here,
   * not left to the child's exit event.
   *
   * `stop()` used to clear the message handler before killing the child, so the
   * exit handler found nothing to deliver the round's end to: `run()` waited on
   * a promise nobody would resolve, and the round row kept a null end time. The
   * agent was not left busy — `stopAgentProcess` clears the registry first — but
   * that round's transcript was never folded into MEMORY and nothing recorded
   * why it stopped. Ending it here makes the stop path and the crash path agree.
   */
  stop(): void {
    const child = this.child;
    this.child = null;
    this.endRoundInFlight('the agent process was stopped');
    this.handler = null;
    this.startedModel = null;
    this.startedLimits = null;
    if (child !== null) {
      child.send({ type: 'shutdown' });
      child.kill();
    }
  }

  /**
   * Delivers a `round_end` for a round this process is still carrying.
   *
   * A round that ends without one leaves `run()` awaiting a promise that will
   * never settle, the round row open, and that round's memory consolidation
   * unreachable. Both the stop path and the exit path call this, so there is one
   * place that knows the rule rather than one guard per caller.
   */
  private endRoundInFlight(detail: string): void {
    const lost = this.activeRoundId;
    if (lost === null) {
      return;
    }
    this.activeRoundId = null;
    this.deps.onProblem(this.agent, detail);
    const handler = this.handler;
    if (handler === null) {
      return;
    }
    handler({
      type: 'round_end',
      roundId: lost,
      endReason: 'model_error',
      finalReply: null,
      error: detail,
    });
  }

  private route(raw: unknown): void {
    const message = parseChildMessage(raw);
    if (message === null) {
      this.deps.onProblem(this.agent, 'the agent process sent an unreadable message');
      return;
    }
    if (message.type === 'ready') {
      const resolve = this.readyResolve;
      this.readyResolve = null;
      if (resolve !== null) {
        resolve();
      }
      return;
    }
    if (message.type === 'round_end') {
      this.activeRoundId = null;
    }
    const handler = this.handler;
    if (handler === null) {
      this.deps.onProblem(this.agent, `the agent process sent ${message.type} outside a round`);
      return;
    }
    handler(message);
  }
}

interface Supervisor {
  ledger: Ledger;
  blackbox: Blackbox;
  registry: RoundRegistry;
  runtimes: Map<string, AgentRuntime>;
  notices: ConsoleNotice[];
  coordinator: RoundCoordinator;
  processes: Map<string, AgentProcess>;
  /** The global pause switch: true freezes time for every agent at once. */
  paused: boolean;
  pause: PauseOrgan;
}

function main(): void {
  let config: AppConfig;
  try {
    config = loadAppConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`Conservatory 无法启动：\n${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { values, models, paths } = config;
  ensureRuntimeDirs(paths);

  const ledger = new Ledger(paths.ledgerPath);
  const blackbox = new Blackbox(paths.blackboxDir);
  const registry = new RoundRegistry();
  // The operator's model roster. A config file written before this feature has
  // no `"models"` block; the store then seeds one from .env and writes it back,
  // so an existing deployment comes up unchanged.
  const modelStore: ModelConfigStore = createModelConfigStore({
    configPath: paths.configPath,
    env: { agent: models.agent, memory: models.memory },
    // The roster file is the operator's. A file that fails validation is left
    // exactly as it is and reported, never replaced with the .env seed: that
    // would delete every provider and key they had with no backup.
    onInvalidRoster: (file, kind) => {
      process.stderr.write(
        `模型清单 ${file} 无法解析（${kind}），已按 .env 的默认值运行，文件未被改动；请修正该文件后重启。
`,
      );
    },
    listBoundAgents: () =>
      ledger
        .listAgents()
        .filter((agent) => agent.status === 'alive')
        .map((agent) => ({
          agent: agent.name,
          providerId: (() => {
            const resolution = resolveAgentModel({
              binding: readModelBinding(paths, agent.name),
              store: modelStore,
              ledgerModel: agent.model,
              fallback: models.agent,
            });
            return resolution.ok ? resolution.resolved.providerId : '';
          })(),
        })),
  });
  // The memory brain is resolved per request, not fixed at boot. An operator
  // who changes the default memory model in the console expects the very next
  // round to use it; capturing the `.env` settings here would keep the old
  // endpoint alive until a restart, which is a setting that silently does
  // nothing.
  const memoryModel: ModelClient = {
    chat: async (request) => {
      const selection = modelStore.defaultMemorySelection();
      const activeSettings = modelStore.settingsFor(selection) ?? models.memory;
      const client = new OpenAICompatibleClient(
        activeSettings,
        values.modelRequestTimeoutSeconds * 1000,
      );
      return client.chat(request);
    },
  };
  const now = (): number => Date.now();
  // One library for the whole process: it carries the load mode, the cached
  // text, the built-in fallbacks, and the status the console reports.
  const prompts = createPromptLibrary(paths);
  const promptNotices = new PromptWarningNotices();
  // The command sandbox's policy: one live object the console edits and every
  // command reads, so an operator change takes effect on the next command.
  const sandbox = createSandboxPolicyStore({
    configPath: paths.configPath,
    agentsDir: paths.agentsDir,
    supervisorDir: paths.supervisorDir,
    listAgentHomes: () => ledger.listAgents().map((agent) => agentHomeDir(paths, agent.name)),
    initial: config.sandbox,
  });

  const state: Supervisor = {
    ledger,
    blackbox,
    registry,
    runtimes: new Map<string, AgentRuntime>(),
    notices: [],
    coordinator: new RoundCoordinator({
      ledger,
      values,
      paths,
      blackbox,
      now,
      memory: memoryModel,
      prompts,
      sandbox,
      onPromptWarnings: (warnings) => {
        reportPromptWarnings(warnings);
      },
      onMemoryError: (agent, message) => {
        addNotice(state, agent, message, now());
      },
      // The memory model broke the ledger's frozen sentences in every session
      // of one step. That is not a bad answer, it is the mechanism that carries
      // an agent between rounds failing, so the whole conservatory stops and
      // the operator decides what to do. The pause is recorded like any other.
      onPauseConservatory: (agent, reason, at) => {
        const outcome = state.pause.set(true, at);
        state.paused = outcome.paused;
        addNotice(
          state,
          PAUSED_SETTING_AGENT,
          `因 ${agent} 的记忆模型在单回合内连续 ${MAX_MEMORY_SESSIONS_PER_ROUND} 次会话（每次满 ${MAX_SANDBOX_REJECTIONS_PER_SESSION} 次违规）触碰或破坏冻结句（${reason}），系统已自动全局暂停温室。`,
          at,
        );
      },
    }),
    processes: new Map<string, AgentProcess>(),
    // Re-read from the ledger below, once the object exists: a restart while
    // paused must come back paused, with the same pause start time.
    paused: false,
    pause: createPauseOrgan({
      ledger,
      values,
      recordIntervention: (paused, pausedDurationMs, at) => {
        recordPauseIntervention(state, paused, pausedDurationMs, at);
      },
    }),
  };
  state.paused = state.pause.isPaused();

  /** A broken template is worth exactly one notice until it is fixed again. */
  function reportPromptWarnings(warnings: readonly string[]): void {
    for (const warning of promptNotices.take(warnings)) {
      addNotice(state, 'supervisor', warning, now());
    }
  }
  // Check at startup as well, so a missing prompt file is visible immediately
  // rather than at the first wake-up.
  reportPromptWarnings(prompts.status().warnings);

  const workerPath = path.join(__dirname, '..', 'agent', 'worker.ts');
  const loaderUrl = pathToFileURL(require.resolve('tsx')).href;

  function runtimeOf(agent: string): AgentRuntime {
    const existing = state.runtimes.get(agent);
    if (existing !== undefined) {
      return existing;
    }
    const created = emptyRuntime();
    state.runtimes.set(agent, created);
    return created;
  }

  /**
   * The brain one agent runs on, resolved in the order that protects it best:
   * its own frozen binding first, then the ledger's model name matched against
   * the roster, then the `.env` default. See `resolveAgentModel`.
   *
   * A refusal is a real outcome: it means the roster no longer serves the model
   * the ledger names, and the agent must wait for the operator rather than wake
   * on a different brain than every record of it says.
   */
  function resolveModelFor(name: string): ModelResolution {
    const record = ledger.getAgent(name);
    return resolveAgentModel({
      binding: readModelBinding(paths, name),
      store: modelStore,
      ledgerModel: record === null ? models.agent.model : record.model,
      fallback: models.agent,
    });
  }

  function processOf(agent: string): AgentProcess {
    const existing = state.processes.get(agent);
    if (existing !== undefined) {
      return existing;
    }
    const created = new AgentProcess(agent, {
      workerPath,
      loaderUrl,
      homeDir: path.join(paths.agentsDir, agent),
      // Read at start, not at construction: an operator switch between two
      // wake-ups must reach the next process, and this object is cached.
      resolveModel: () => {
        const resolved = resolveModelFor(agent);
        if (!resolved.ok) {
          // The roster no longer serves this agent's model. Starting a process
          // on a different brain is the silent swap this whole path prevents, so
          // the start fails with the reason and the round reports it.
          throw new Error(
            `the model this agent records (${ledger.getAgent(agent)?.model ?? '?'}) is not in the model roster (${resolved.error}); bind the agent to a model in the console`,
          );
        }
        return {
          settings: resolved.resolved.settings,
          modelName: modelFingerprint(resolved.resolved.settings, resolved.resolved.providerId),
        };
      },
      roundContextCapTokens: values.roundContextCapTokens,
      maxToolCallsPerRound: values.maxToolCallsPerRound,
      modelRequestTimeoutSeconds: values.modelRequestTimeoutSeconds,
      // The live numbers, so a limit retuned in the console reaches the next
      // process without a restart. The three above are only a fallback.
      limits: () => ({
        roundContextCapTokens: values.roundContextCapTokens,
        maxToolCallsPerRound: values.maxToolCallsPerRound,
        modelRequestTimeoutSeconds: values.modelRequestTimeoutSeconds,
      }),
      onProblem: (name, message) => {
        runtimeOf(name).lastError = message;
        blackbox.append(name, 'worker_problem', now(), null, { message });
        addNotice(state, name, message, now());
      },
    });
    state.processes.set(agent, created);
    return created;
  }

  /**
   * The operator's "wake up now". It answers immediately.
   *
   * A round can take minutes, and the console's HTTP request used to wait for
   * all of it — the button stayed stuck and the page could not even show that
   * something had started. So the checks and the bookkeeping happen here, the
   * round itself is handed to `runWakeRound`, and the caller is told "yes,
   * woken" the moment the round is actually under way. The registry is marked
   * before returning, which is what makes the very next state poll show
   * `busy: true`.
   */
  async function wakeAgent(
    name: string,
  ): Promise<{ ok: true; woken: boolean; reason: string | null } | { ok: false; error: string }> {
    const agent = ledger.getAgent(name);
    if (agent === null) {
      return { ok: false, error: 'agent_not_found' };
    }
    if (agent.status !== 'alive') {
      return { ok: true, woken: false, reason: '该 Agent 已经不是活着的状态' };
    }
    // A paused conservatory is not a lock on the switch: the operator's own
    // "wake up now" still opens a round, which is how a pause is debugged.
    if (registry.isBusy(name)) {
      return { ok: true, woken: false, reason: '该 agent 正在一轮中，本次唤醒已跳过' };
    }
    const runtime = runtimeOf(name);
    registry.markStarted(name);
    runtime.lastWakeAt = now();
    // Deliberately not awaited: the round is the agent's time, not the
    // operator's. `runWakeRound` ends the round on every path, including its
    // own failures, so nothing here can leave an agent marked busy forever.
    void runWakeRound(agent);
    return { ok: true, woken: true, reason: null };
  }

  /** One wake-up's worth of work, run after `wakeAgent` has already answered. */
  async function runWakeRound(agent: AgentRecord): Promise<void> {
    const name = agent.name;
    const runtime = runtimeOf(name);
    try {
      // Before the process starts, so a legacy agent is frozen on the brain it
      // is about to run with rather than on whatever the roster says later.
      ensureBindingFrozen(name);
      const agentProcess = processOf(name);
      await agentProcess.ensureStarted();
      const outcome = await state.coordinator.run(agent, agentProcess);
      runtime.lastRoundAt = now();
      runtime.lastRoundEndReason = outcome.endReason;
      if (outcome.error !== null) {
        runtime.lastError = outcome.error;
        addNotice(state, name, `本轮以 ${outcome.endReason} 结束：${outcome.error}`, now());
      } else {
        runtime.lastError = null;
      }
      // A switch that arrived while this round was running was written to the
      // ledger and the binding but could not touch the live process. Retire it
      // now, so the next wake-up forks a process on the new brain. Doing this
      // outside the round is what keeps a switch from cutting a round in half.
      retireProcessIfModelChanged(name);
    } catch (error) {
      const message = messageOf(error);
      runtime.lastError = message;
      blackbox.append(name, 'round_failed', now(), null, { message });
      addNotice(state, name, `本轮执行失败：${message}`, now());
    } finally {
      registry.markEnded(name);
    }
  }

  /**
   * Death, once. The ledger transaction marks the agent dead, releases its
   * held work and files the certificate; the process is then stopped and goes
   * out of `state.processes`, the black box keeps its own record, and nothing
   * in this file offers a way back.
   */
  function runDeath(agent: string, cause: DeathCause): DeathOutcome {
    return die(
      {
        ledger,
        values,
        paths,
        blackbox,
        now,
        stopProcess: stopAgentProcess,
        onNotice: (name, message) => {
          addNotice(state, name, message, now());
        },
      },
      agent,
      cause,
      now(),
    );
  }

  /** Stops one agent's process and drops it, without touching the ledger. */
  function stopAgentProcess(name: string): void {
    const running = state.processes.get(name);
    if (running === undefined) {
      return;
    }
    state.processes.delete(name);
    registry.markEnded(name);
    running.stop();
  }

  /**
   * The running process is carrying an old brain: the model it started with is
   * no longer what the binding and roster resolve to. Stopping it here means
   * the next wake-up forks a fresh process on the new model.
   *
   * The comparison is over the whole fingerprint, not the model name: retuning
   * a provider's base URL, rotating its key, or changing the thinking level is
   * as much a new brain as renaming the model, and a process left running on
   * the old endpoint would answer to a configuration that no longer exists.
   */
  function retireProcessIfModelChanged(name: string): boolean {
    const running = state.processes.get(name);
    if (running === undefined) {
      return false;
    }
    const resolved = resolveModelFor(name);
    const outdated = shouldRetireProcess({
      startedModel: running.currentModel(),
      // A refusal is not a reason to tear a live process down: it cannot name a
      // brain, so there is nothing to compare against.
      resolvedModel: resolved.ok
        ? modelFingerprint(resolved.resolved.settings, resolved.resolved.providerId)
        : null,
    });
    if (!outdated) {
      return retireProcessIfLimitsChanged(name, running);
    }
    stopAgentProcess(name);
    return true;
  }

  /**
   * The running process was initialized with round limits the operator has
   * since changed. The child is told its caps once, at startup, so a process
   * left running would keep enforcing the old numbers — a limit the operator
   * set and cannot see taking effect. Retiring it means the next wake-up forks
   * a fresh process that reads the live values.
   *
   * Only the three limits the child is told about are compared. Everything else
   * in `values` is read by the supervisor itself, on every use, and needs no
   * process restart.
   */
  function retireProcessIfLimitsChanged(name: string, running: AgentProcess): boolean {
    const started = running.currentLimits();
    if (started === null) {
      return false;
    }
    if (
      started.roundContextCapTokens === values.roundContextCapTokens &&
      started.maxToolCallsPerRound === values.maxToolCallsPerRound &&
      started.modelRequestTimeoutSeconds === values.modelRequestTimeoutSeconds
    ) {
      return false;
    }
    stopAgentProcess(name);
    return true;
  }

  /**
   * An agent born before the roster existed has no binding of its own, so it
   * would otherwise follow the operator's later edits — the exact silent change
   * of brain this design exists to prevent. The first wake-up freezes the brain
   * the ledger already names into the agent's own home, and after that it is like
   * any other agent. A failure here is a notice, never a refusal to wake.
   */
  function ensureBindingFrozen(name: string): void {
    if (readModelBinding(paths, name) !== null) {
      return;
    }
    const resolution = resolveModelFor(name);
    if (!resolution.ok) {
      // The roster does not serve the ledger's model. Nothing is frozen, because
      // freezing the default here is precisely the silent swap: the ledger would
      // go on saying one model while the agent ran another, for life.
      addNotice(
        state,
        name,
        `${name} 记录的模型（${ledger.getAgent(name)?.model ?? '?'}）不在当前模型清单里，无法冻结绑定；请在控制台给它指定一个模型。`,
        now(),
      );
      return;
    }
    const resolved = resolution.resolved;
    if (resolved.providerId === '') {
      // Nothing in the roster describes this model; `.env` is all there is, and
      // there is no provider id to freeze. Leave it on the environment.
      return;
    }
    try {
      writeModelBinding(paths, name, {
        providerId: resolved.providerId,
        providerName: resolved.providerName,
        baseUrl: resolved.settings.baseUrl,
        apiKey: resolved.settings.apiKey,
        model: resolved.settings.model,
        ...(resolved.settings.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: resolved.settings.reasoningEffort }),
        boundAt: now(),
      });
      addNotice(
        state,
        name,
        `${name} 出了模型清单出现之前，已把它记录里正在使用的模型（${resolved.settings.model}）冻结到自己文件夹的 MODEL.json。`,
        now(),
      );
    } catch (error) {
      addNotice(state, name, `模型绑定文件冻结失败：${messageOf(error)}`, now());
    }
  }

  /**
   * The operator switches one living agent's brain. The decision, the record
   * and the deferred-vs-immediate answer all live in the organ; this only hands
   * it the live process map and the notice channel.
   */
  function switchModel(
    name: string,
    providerId: string,
    model: string,
    reasoningEffort?: ReasoningEffort | null,
  ): SwitchModelOutcome {
    // Checked here as well so an unknown agent answers with a code the console
    // has a translation for, rather than a bare string it would echo raw.
    if (ledger.getAgent(name) === null) {
      return { ok: false, error: 'agent_not_found' };
    }
    return switchAgentModel(
      {
        ledger,
        paths,
        blackbox,
        store: modelStore,
        now,
        isBusy: (agent) => registry.isBusy(agent),
        retireProcess: stopAgentProcess,
        onNotice: (agent, message, at) => {
          addNotice(state, agent, message, at);
        },
      },
      name,
      providerId,
      model,
      reasoningEffort,
    );
  }

  /** The operator treats a wound on the agent's behalf: a recorded intervention. */
  function treatAsOperator(
    agent: string,
    woundId: number,
    tier: TreatmentTier,
  ): { ok: true } | { ok: false; error: string } {
    const record = ledger.getAgent(agent);
    if (record === null) {
      return { ok: false, error: 'agent_not_found' };
    }
    if (record.status !== 'alive') {
      return { ok: false, error: 'agent_dead' };
    }
    if (registry.isBusy(agent)) {
      return { ok: false, error: 'agent_busy' };
    }
    const at = now();
    const outcome = treat(
      { ledger, values, paths, blackbox, now },
      agent,
      woundId,
      tier,
      'operator',
    );
    if (!outcome.ok) {
      return { ok: false, error: outcome.code };
    }
    ledger.appendIntervention(
      'operator_treat',
      agent,
      `操作员替 ${agent} 治疗伤口 ${woundId}（${tier === 'ordinary' ? '普通' : '完全'}治疗，未扣该 agent 余额）`,
      at,
    );
    blackbox.append(agent, 'intervention', at, null, { kind: 'operator_treat', woundId, tier });
    addNotice(state, agent, `操作员替 ${agent} 治疗了伤口 ${woundId}（${tier}）。`, at);
    return { ok: true };
  }

  /** The operator's forced termination: a warning, a record, and then death. */
  function terminateAgent(agent: string, confirmName: string): { ok: true } | { ok: false; error: string } {
    const result = terminateByOperator(
      {
        ledger,
        values,
        paths,
        blackbox,
        now,
        stopProcess: stopAgentProcess,
        onNotice: (name, message) => {
          addNotice(state, name, message, now());
        },
      },
      agent,
      confirmName,
    );
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /**
   * Total erasure, on the operator's explicit confirmation. Unlike termination
   * this leaves nothing behind: the process, the ledger rows, the home and the
   * black box all go. The supervisor's own per-agent maps are cleared too, so a
   * later agent may take the same name without inheriting a stale runtime or a
   * cached process.
   *
   * This is refused while the agent is mid-round rather than killing a round in
   * flight: `eraseAgent` stops the process, so the guard is about not pulling
   * the ground out from under an in-flight write.
   */
  function eraseOne(
    agent: string,
    confirmName: string,
  ): { ok: true } | { ok: false; error: string } {
    const record = ledger.getAgent(agent);
    if (record === null) {
      return { ok: false, error: 'agent_not_found' };
    }
    if (confirmName !== agent) {
      return { ok: false, error: 'confirm_name_mismatch' };
    }
    if (registry.isBusy(agent)) {
      return { ok: false, error: 'agent_busy_try_later' };
    }
    const outcome: EraseOutcome = eraseAgent(
      {
        ledger,
        blackbox,
        paths,
        now,
        stopProcess: stopAgentProcess,
        onNotice: (name, message) => {
          addNotice(state, name, message, now());
        },
      },
      agent,
    );
    if (!outcome.ok) {
      return { ok: false, error: outcome.error };
    }
    // Nothing may reference a name that is gone. The ledger rows are already
    // deleted, so these maps are the last trace left in this process.
    state.runtimes.delete(agent);
    state.processes.delete(agent);
    return { ok: true };
  }

  /**
   * One beat of the redaction clock: every living agent that is not mid-round
   * loses the characters it owes, and one that has reached the death line dies.
   * A busy agent is skipped and its debt is paid on a later beat, so a round
   * ending and a memory rewrite can never write MEMORY at the same time.
   */
  function redactionTick(): void {
    if (state.paused) {
      return;
    }
    for (const agent of ledger.listAgents()) {
      if (agent.status !== 'alive' || registry.isBusy(agent.name)) {
        continue;
      }
      const result = redactAgent(
        {
          ledger,
          values,
          blackbox,
          now,
          readMemory: (name) => readMemoryFile(paths, name),
          writeMemory: (name, text) => {
            writeMemoryAtomic(paths, name, text);
          },
          random: Math.random,
        },
        agent.name,
      );
      if (result.skipped > 0) {
        addNotice(
          state,
          agent.name,
          `${agent.name} 在挨饿，但 MEMORY 里已经没有可遮盖的字符了（发育期：可涂的字还不够）。`,
          now(),
        );
      } else if (result.applied > 1) {
        addNotice(
          state,
          agent.name,
          `${agent.name} 在挨饿：本次补上 ${result.applied} 次遮盖（欠账已全部补清）。`,
          now(),
        );
      }
      // The mechanism decides: nothing here compares the count itself.
      const outcome = checkDeathLine(
        {
          ledger,
          values,
          paths,
          blackbox,
          now,
          stopProcess: stopAgentProcess,
          onNotice: (name, message) => {
            addNotice(state, name, message, now());
          },
        },
        agent.name,
      );
      if (outcome !== null && !outcome.ok) {
        blackbox.append(agent.name, 'death_refused', now(), null, { error: outcome.error });
      }
    }
  }

  /**
   * One beat of the conservatory's clock: claimed tasks past their timeout go
   * back to the board, then every living agent is woken.
   *
   * While the operator has paused the conservatory this does nothing at all:
   * no round is started and no claim expires, because the paused span is added
   * back to every claim clock when the switch goes off. The console's explicit
   * "wake up now" does not come through here, so it still opens a round while
   * paused — that is the one deliberate door left open for debugging.
   */
  async function tick(): Promise<void> {
    if (state.paused) {
      return;
    }
    const expired = expireClaims(ledger, now(), values.taskClaimTimeoutHours);
    for (const claim of expired) {
      blackbox.append(claim.agent, 'claim_expired', now(), null, { taskId: claim.taskId });
    }
    wakeLivingAgents({
      ledger,
      registry,
      wake: (agent) => {
        void wakeAgent(agent.name);
      },
    });
  }

  /**
   * The operator edits the body's numbers from the console. This is the whole
   * hot-apply path: validate, protect the past, persist, then put the new
   * numbers in force — and it is deliberately ordered so that a failure at any
   * step leaves the running conservatory exactly as it was.
   *
   * The one subtle step is the decay rate. Satiety is stored as an anchor (a
   * value plus the instant it was true) and derived from wall-clock time, so
   * changing the rate without touching the anchors would silently re-price
   * every second an agent has already lived: raising the rate would make a
   * living agent retroactively starve. Re-anchoring each agent at the current
   * instant with its current satiety makes the new rate apply from now on and
   * from nothing earlier.
   */
  function updateValues(
    patch: unknown,
  ): { ok: true; values: ConservatoryValues } | { ok: false; error: string } {
    const result = validateValuesPatch(values, patch);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const next = result.next;

    // A paused conservatory has time stopped: its anchors already hold the
    // frozen values, and re-anchoring them at `now` would quietly charge the
    // paused span to the agents' hunger.
    const decayChanged = next.satietyDecayPerSecond !== values.satietyDecayPerSecond;
    if (decayChanged && !ledger.getPauseState().paused) {
      const at = now();
      // The OLD values, so each agent's satiety is read under the rule that
      // was actually in force up to this instant.
      ledger.transaction(() => {
        for (const agent of ledger.listAgents()) {
          if (agent.status !== 'alive') {
            continue;
          }
          if (ledger.getSatietyAnchor(agent.name) === null) {
            continue;
          }
          const current = readSatiety(ledger, values, agent.name, at);
          ledger.setSatietyAnchor(agent.name, current, at);
        }
      });
    }

    // Written before the in-memory swap: a file that cannot be written is a
    // refusal, not a change that vanishes on the next restart.
    try {
      persistConservatoryValues(paths.configPath, next);
    } catch (error) {
      return { ok: false, error: `配置文件写回失败：${messageOf(error)}` };
    }

    Object.assign(values, next);

    // The two clocks take the new period immediately; a heartbeat that kept
    // beating at the old interval would be a setting that only looks applied.
    heartbeat.setIntervalSeconds(values.heartbeatSeconds);
    redactionHeartbeat.setIntervalSeconds(values.redactionIntervalSeconds);

    // The child is told its three round limits once, at startup. An idle
    // process is retired here so the next wake-up reads the new numbers; a busy
    // one is left alone and retired at the end of its round, so a running round
    // is never cut in half.
    for (const name of Array.from(state.processes.keys())) {
      if (registry.isBusy(name)) {
        continue;
      }
      const running = state.processes.get(name);
      if (running !== undefined) {
        retireProcessIfLimitsChanged(name, running);
      }
    }

    return { ok: true, values };
  }

  const heartbeat = new Heartbeat({
    intervalSeconds: values.heartbeatSeconds,
    now,
    tick,
    isPaused: () => state.paused,
    onError: (error) => {
      const message = messageOf(error);
      process.stderr.write(`心跳出错：${message}\n`);
      state.notices.push({ at: now(), agent: 'supervisor', message: `心跳出错：${message}` });
    },
  });

  /**
   * The redaction clock is its own beat: it runs on the redaction interval
   * rather than the heartbeat's, and like the heartbeat it does nothing while
   * the conservatory is paused, because time is stopped.
   */
  const redactionHeartbeat = new Heartbeat({
    intervalSeconds: values.redactionIntervalSeconds,
    now,
    tick: () => {
      redactionTick();
    },
    isPaused: () => state.paused,
    onError: (error) => {
      const message = messageOf(error);
      process.stderr.write(`遮盖出错：${message}\n`);
      state.notices.push({ at: now(), agent: 'supervisor', message: `遮盖出错：${message}` });
    },
  });

  const operatorToken = randomBytes(32).toString('hex');
  const consoleServer = createConsoleServer({
    values,
    paths,
    // Minted here and printed in the banner: the operator's page gets it as an
    // HttpOnly cookie, and a confined command that guesses the URL has no way to
    // read it.
    operatorToken,
    sandboxPolicy: sandbox,
    modelStore,
    ledger,
    blackbox,
    registry,
    prompts,
    indexHtmlPath: path.join(__dirname, '..', 'console', 'public', 'index.html'),
    now,
    getRuntime: (name): RuntimeInfo => {
      const runtime = runtimeOf(name);
      return {
        busy: registry.isBusy(name),
        lastWakeAt: runtime.lastWakeAt,
        lastRoundAt: runtime.lastRoundAt,
        lastRoundEndReason: runtime.lastRoundEndReason,
        lastError: runtime.lastError,
      };
    },
    createAgent: async (name, providerId, model, reasoningEffort) => {
      // A new agent's brain: the operator's choice when they made one, else the
      // configured default. Either way it is resolved to a concrete endpoint
      // before birth, and frozen into the agent's home.
      const chosenEffort: ReasoningEffort | undefined = isReasoningEffort(reasoningEffort)
        ? reasoningEffort
        : undefined;
      let resolved: ResolvedAgentModel;
      if (providerId !== undefined || model !== undefined) {
        const defaultSelection = modelStore.defaultAgentSelection();
        const wantedProvider = providerId ?? defaultSelection.providerId;
        const provider = modelStore.getProvider(wantedProvider);
        if (provider === null) {
          return { ok: false, error: 'unknown_provider' };
        }
        const wantedModel = model ?? defaultSelection.model;
        if (!provider.models.includes(wantedModel)) {
          return { ok: false, error: 'unknown_model' };
        }
        // An explicit level wins. With none given, the default's level follows
        // the default's model name, exactly as `resolveAgentModel` does for a
        // legacy agent — so the panel's "thinking" column is not a lie about
        // the brain an agent born on that same model actually got.
        const effort =
          chosenEffort ??
          (wantedModel === defaultSelection.model ? defaultSelection.reasoningEffort : undefined);
        resolved = {
          settings: {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            model: wantedModel,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          },
          providerId: provider.id,
          providerName: provider.name,
          source: 'roster',
        };
      } else {
        // A newborn has no ledger model of its own, so the default applies; a
        // resolution that cannot name one refuses the birth rather than writing
        // a ledger row no brain answers to.
        const byDefault = resolveAgentModel({
          binding: null,
          store: modelStore,
          ledgerModel: '',
          fallback: models.agent,
        });
        if (!byDefault.ok) {
          return { ok: false, error: byDefault.error };
        }
        resolved =
          chosenEffort === undefined
            ? byDefault.resolved
            : {
                ...byDefault.resolved,
                settings: { ...byDefault.resolved.settings, reasoningEffort: chosenEffort },
              };
      }
      const result = createAgent({
        name,
        model: resolved.settings.model,
        now: now(),
        ledger,
        values,
        paths,
      });
      if (!result.ok) {
        return { ok: false, error: result.code };
      }
      const at = now();
      try {
        writeModelBinding(paths, name, {
          providerId: resolved.providerId,
          providerName: resolved.providerName,
          baseUrl: resolved.settings.baseUrl,
          apiKey: resolved.settings.apiKey,
          model: resolved.settings.model,
          ...(resolved.settings.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.settings.reasoningEffort }),
          boundAt: at,
        });
      } catch (error) {
        // The agent exists and its ledger row is correct; a home that cannot
        // hold the binding file is worth a notice, not a half-created agent.
        addNotice(state, name, `模型绑定文件写入失败：${messageOf(error)}`, at);
      }
      blackbox.append(name, 'agent_created', at, null, {
        model: resolved.settings.model,
        providerId: resolved.providerId,
        bindingSource: resolved.source,
      });
      runtimeOf(name);
      return { ok: true };
    },
    wakeAgent,
    switchAgentModel: switchModel,
    updateValues,
    setPaused: (paused) => {
      const outcome = state.pause.set(paused, now());
      state.paused = outcome.paused;
      if (outcome.changed) {
        addNotice(
          state,
          PAUSED_SETTING_AGENT,
          paused
            ? '操作员暂停了温室：所有 Agent 不会被唤醒，饱食度与认领计时冻结。'
            : `操作员恢复了温室：时间重新流动，本次暂停 ${formatPauseDuration(outcome.pausedDurationMs ?? 0)}。`,
          now(),
        );
      }
      return { ok: true, changed: outcome.changed, state: ledger.getPauseState() };
    },
    intervene: async (agent, kind: InterventionKind, amount) => {
      if (ledger.getAgent(agent) === null) {
        return { ok: false, error: 'agent_not_found' };
      }
      if (ledger.getAgent(agent)?.status !== 'alive') {
        return { ok: false, error: 'agent_dead' };
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: 'invalid_amount_intervention' };
      }
      const at = now();
      ledger.transaction(() => {
        if (kind === 'give_balance') {
          ledger.appendBalanceEvent(agent, amount, 'intervention_balance', null, at);
        } else {
          grantSatiety(ledger, values, agent, amount, at);
        }
        ledger.appendIntervention(kind, agent, interventionDetail(kind, amount), at);
      });
      blackbox.append(agent, 'intervention', at, null, { kind, amount });
      return {
        ok: true,
        balance: ledger.getBalance(agent),
        satiety: readSatiety(ledger, values, agent, at),
      };
    },
    treatWound: treatAsOperator,
    terminateAgent,
    eraseAgent: eraseOne,
    getNotices: () => state.notices.slice(-20),
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdout.write(`\n收到 ${signal}，正在关闭……\n`);
    heartbeat.stop();
    redactionHeartbeat.stop();
    consoleServer.close();
    for (const agentProcess of state.processes.values()) {
      agentProcess.stop();
    }
    ledger.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  consoleServer.on('error', (error: NodeJS.ErrnoException) => {
    process.stderr.write(
      `无法监听 127.0.0.1:${values.consolePort}：${error.message}\n` +
        '（端口被占用时，可以修改 conservatory.config.json 里的 consolePort）\n',
    );
    process.exitCode = 1;
  });

  consoleServer.listen(values.consolePort, '127.0.0.1', () => {
    const living = ledger.listAgents().filter((agent) => agent.status === 'alive');
    const promptStatus = prompts.status();
    process.stdout.write(
      [
        'Conservatory 已启动。',
        `控制台：http://127.0.0.1:${values.consolePort}（页面会自动带上访问凭据）`,
        `操作员口令：${operatorToken}`,
        `心跳：每 ${values.heartbeatSeconds} 秒`,
        `槽位：${listSlots(values, ledger).length}`,
        `活着的 Agent：${living.length === 0 ? '（还没有，请在控制台的空槽位里创建一个）' : living.map((a) => a.name).join(', ')}`,
        `汇率：${values.exchangeRate === null ? '未设定（收入申报无法入账）' : String(values.exchangeRate)}`,
        `提示词：${
          promptStatus.healthy
            ? `正常（${promptStatus.mode === 'hot' ? '实时热加载' : '内存缓存'}）`
            : `有警告（见控制台设置页）：${promptStatus.warnings.join('；')}`
        }`,
        `温室：${state.paused ? `已暂停（自 ${new Date(state.pause.read().pausedSince ?? now()).toLocaleString('zh-CN')}）` : '运行中'}`,
        '',
      ].join('\n'),
    );
    heartbeat.start();
    redactionHeartbeat.start();
    // The first beat lands immediately so a freshly started supervisor does not
    // make a living agent wait a whole interval; later beats follow the clock.
    // While the conservatory is paused it wakes nobody, this beat included.
    void tick();
    // The redaction clock takes the same immediate first beat, so an agent that
    // was already starving while the supervisor was off pays what it owes.
    void redactionHeartbeat.runTick();
  });
}

function addNotice(state: Supervisor, agent: string, message: string, at: number): void {
  state.notices.push({ at, agent, message });
  if (state.notices.length > 200) {
    state.notices.splice(0, state.notices.length - 200);
  }
}

/** Operator-facing text, so Chinese; the ledger keeps it verbatim and forever. */
function interventionDetail(kind: InterventionKind, amount: number): string {
  if (kind === 'give_balance') {
    return `操作员直接给予 ${amount} 余额（跳过挣取过程）`;
  }
  if (kind === 'give_satiety') {
    return `操作员直接给予 ${amount} 饱食度（跳过进食与付款）`;
  }
  throw new Error(`intervention ${kind} is not an amount-bearing intervention`);
}

/**
 * The permanent record of a pause or a resume. The row is global — there is no
 * single agent it belongs to — so it is filed under the conservatory itself.
 */
function recordPauseIntervention(
  state: Supervisor,
  paused: boolean,
  pausedDurationMs: number | null,
  at: number,
): void {
  const kind: InterventionKind = paused ? 'conservatory_paused' : 'conservatory_resumed';
  state.ledger.appendIntervention(
    kind,
    PAUSED_SETTING_AGENT,
    pauseInterventionDetail(paused, pausedDurationMs),
    at,
  );
  state.blackbox.append(PAUSED_SETTING_AGENT, 'intervention', at, null, {
    kind,
    pausedDurationMs,
  });
}

const isEntryPoint =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;

if (isEntryPoint) {
  main();
}

export { main };
