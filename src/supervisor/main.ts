import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildToParentMessage, ParentToChildMessage } from '../agent/ipc';
import {
  ConfigError,
  ensureRuntimeDirs,
  loadAppConfig,
  type AppConfig,
  type ModelSettings,
} from '../config';
import { createConsoleServer, type ConsoleNotice, type RuntimeInfo } from '../console/server';
import { OpenAICompatibleClient, type ModelClient } from '../model/client';
import { Blackbox } from '../organs/blackbox';
import { Heartbeat } from '../organs/heartbeat';
import { Ledger, PAUSED_SETTING_AGENT, type InterventionKind } from '../organs/ledger';
import { grantSatiety, readSatiety } from '../organs/metabolism';
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
    return {
      type: 'assistant_message',
      roundId,
      message: { role: 'assistant', content: content === undefined ? null : content },
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

interface AgentProcessDeps {
  workerPath: string;
  loaderUrl: string;
  homeDir: string;
  model: ModelSettings;
  roundContextCapTokens: number;
  maxToolCallsPerRound: number;
  modelRequestTimeoutSeconds: number;
  onProblem(agent: string, message: string): void;
}

/**
 * One agent, one process. The child's working directory is the agent's home,
 * and it is only ever asked to run the model loop; every tool call comes back
 * over IPC for the supervisor to execute.
 */
class AgentProcess implements WorkerTransport {
  private readonly deps: AgentProcessDeps;
  private readonly agent: string;
  private child: ChildProcess | null = null;
  private handler: ((message: ChildToParentMessage) => void) | null = null;
  private readyResolve: (() => void) | null = null;
  private activeRoundId: number | null = null;

  constructor(agent: string, deps: AgentProcessDeps) {
    this.agent = agent;
    this.deps = deps;
  }

  async ensureStarted(): Promise<void> {
    if (this.child !== null) {
      return;
    }
    const child = fork(this.deps.workerPath, [], {
      cwd: this.deps.homeDir,
      execArgv: ['--import', this.deps.loaderUrl],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });
    this.child = child;
    child.on('message', (raw: unknown) => {
      this.route(raw);
    });
    child.on('error', (error: Error) => {
      this.deps.onProblem(this.agent, `agent process error: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.handler = null;
      const resolve = this.readyResolve;
      this.readyResolve = null;
      if (resolve !== null) {
        this.deps.onProblem(this.agent, 'the agent process exited before it was ready');
        resolve();
      }
      if (this.activeRoundId !== null) {
        const lost = this.activeRoundId;
        this.activeRoundId = null;
        this.deps.onProblem(
          this.agent,
          `the agent process exited during round ${lost} (code ${String(code)}, signal ${String(signal)})`,
        );
      }
    });

    await new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.send({
      type: 'init',
      model: this.deps.model,
      roundContextCapTokens: this.deps.roundContextCapTokens,
      maxToolCallsPerRound: this.deps.maxToolCallsPerRound,
      modelRequestTimeoutSeconds: this.deps.modelRequestTimeoutSeconds,
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

  stop(): void {
    const child = this.child;
    this.child = null;
    this.handler = null;
    if (child !== null) {
      child.send({ type: 'shutdown' });
      child.kill();
    }
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
  const memoryModel: ModelClient = new OpenAICompatibleClient(
    models.memory,
    values.modelRequestTimeoutSeconds * 1000,
  );
  const now = (): number => Date.now();

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
      onMemoryError: (agent, message) => {
        addNotice(state, agent, message, now());
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

  function processOf(agent: string): AgentProcess {
    const existing = state.processes.get(agent);
    if (existing !== undefined) {
      return existing;
    }
    const created = new AgentProcess(agent, {
      workerPath,
      loaderUrl,
      homeDir: path.join(paths.agentsDir, agent),
      model: models.agent,
      roundContextCapTokens: values.roundContextCapTokens,
      maxToolCallsPerRound: values.maxToolCallsPerRound,
      modelRequestTimeoutSeconds: values.modelRequestTimeoutSeconds,
      onProblem: (name, message) => {
        runtimeOf(name).lastError = message;
        blackbox.append(name, 'worker_problem', now(), null, { message });
        addNotice(state, name, message, now());
      },
    });
    state.processes.set(agent, created);
    return created;
  }

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
    try {
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
    } catch (error) {
      const message = messageOf(error);
      runtime.lastError = message;
      blackbox.append(name, 'round_failed', now(), null, { message });
      addNotice(state, name, `本轮执行失败：${message}`, now());
    } finally {
      registry.markEnded(name);
    }
    return { ok: true, woken: true, reason: null };
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

  const consoleServer = createConsoleServer({
    values,
    paths,
    ledger,
    blackbox,
    registry,
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
    createAgent: async (name) => {
      const result = createAgent({
        name,
        model: models.agent.model,
        now: now(),
        ledger,
        values,
        paths,
      });
      if (!result.ok) {
        return { ok: false, error: result.code };
      }
      blackbox.append(name, 'agent_created', now(), null, { model: models.agent.model });
      runtimeOf(name);
      return { ok: true };
    },
    wakeAgent,
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
    process.stdout.write(
      [
        'Conservatory 已启动。',
        `控制台：http://127.0.0.1:${values.consolePort}`,
        `心跳：每 ${values.heartbeatSeconds} 秒`,
        `槽位：${listSlots(values, ledger).length}（第 1 步只允许 1 个活着的 Agent）`,
        `活着的 Agent：${living.length === 0 ? '（还没有，请在控制台的空槽位里创建一个）' : living.map((a) => a.name).join(', ')}`,
        `汇率：${values.exchangeRate === null ? '未设定（收入申报无法入账）' : String(values.exchangeRate)}`,
        `温室：${state.paused ? `已暂停（自 ${new Date(state.pause.read().pausedSince ?? now()).toLocaleString('zh-CN')}）` : '运行中'}`,
        '',
      ].join('\n'),
    );
    heartbeat.start();
    // The first beat lands immediately so a freshly started supervisor does not
    // make a living agent wait a whole interval; later beats follow the clock.
    // While the conservatory is paused it wakes nobody, this beat included.
    void tick();
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
