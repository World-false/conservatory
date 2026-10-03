import type { AgentRecord } from '../organs/ledger';
import type {
  ChildToParentMessage,
  ParentToChildMessage,
  RoundEndReason,
  RoundTranscript,
  RoundTranscriptEntry,
  ToolSchema,
} from '../agent/ipc';
import type { ConservatoryValues, RuntimePaths } from '../config';
import type { ModelClient } from '../model/client';
import type { Blackbox } from '../organs/blackbox';
import { reportIncome } from '../organs/income';
import type { Ledger } from '../organs/ledger';
import { consolidateMemory, isoTime, readMemoryFile, type MemoryOutcome } from '../organs/memory';
import { eat, formatAmount, readBodyStatus } from '../organs/metabolism';
import { renderUserContext, type PromptLibrary } from '../organs/prompts';
import {
  listNotebook,
  NotebookError,
  readNotebookFile,
  writeNotebookFile,
} from '../organs/notebook';
import { claimTask, listBoardTasks, submitTask } from '../organs/taskboard';

export const OPERATOR = 'operator';

/** The complete tool set of step 1. There are no others. */
export const AGENT_TOOLS: ToolSchema[] = [
  {
    name: 'get_status',
    description:
      'Returns your current body state: satiety, the satiety ceiling, your balance, the price of one meal, and how much satiety a meal restores.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'eat',
    description:
      'Buys one meal. Costs the meal price and raises satiety by the satiety per meal, up to the ceiling. Refused when your balance is below the meal price.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'list_tasks',
    description:
      'Lists the tasks nobody has claimed yet, and the tasks you have claimed or that were sent back to you for rework.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'claim_task',
    description:
      'Claims an open task. A claimed task is locked to you until you submit it, the operator returns it to the board, or the claim times out.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The id of the task to claim.' } },
      required: ['task_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_task',
    description:
      'Delivers a task you hold. The operator then accepts it (and pays the price), rejects it (and pays nothing), sends it back to you for rework, or returns it to the board.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The id of the task you are delivering.' },
        deliverable: { type: 'string', description: 'The work itself, as text.' },
      },
      required: ['task_id', 'deliverable'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_income',
    description:
      'Reports real money you earned outside, for the operator to verify. It becomes balance only after the operator verifies it, converted at a fixed exchange rate.',
    parameters: {
      type: 'object',
      properties: {
        where: { type: 'string', description: 'Where the work was done or the platform it was done on.' },
        work: { type: 'string', description: 'What work you did.' },
        amount: { type: 'number', description: 'How much you were paid, in the currency named below.' },
        currency: { type: 'string', description: 'The currency code you were paid in.' },
      },
      required: ['where', 'work', 'amount', 'currency'],
      additionalProperties: false,
    },
  },
  {
    name: 'message_operator',
    description:
      'Leaves a message for the operator. The operator may read it; nothing is guaranteed beyond that.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The message to leave for the operator.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'notebook_list',
    description: 'Lists the files in your private notebook.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'notebook_read',
    description: 'Reads one file from your private notebook.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path inside your notebook, for example notes/todo.txt.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'notebook_write',
    description: 'Writes one file in your private notebook, replacing its contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path inside your notebook, for example notes/todo.txt.' },
        content: { type: 'string', description: 'The full text to store.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
];

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/** Tools that take no arguments; some providers send no arguments at all. */
const NO_ARGUMENT_TOOLS = new Set(['get_status', 'eat', 'list_tasks', 'notebook_list']);

export interface ToolDeps {
  ledger: Ledger;
  values: ConservatoryValues;
  paths: RuntimePaths;
  blackbox: Blackbox;
  now(): number;
}

type ArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function parseArguments(argumentsJson: string): ArgsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `arguments were not valid JSON: ${detail}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'arguments must be a JSON object' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function readStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

function readNumberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fail(error: string): ToolOutcome {
  return { content: JSON.stringify({ ok: false, error }), isError: true };
}

function ok(value: Record<string, unknown>): ToolOutcome {
  return { content: JSON.stringify({ ok: true, ...value }), isError: false };
}

/**
 * Runs one tool call for one agent. Everything an agent can do passes through
 * here, so this is the only place that reads or writes the ledger on its behalf.
 */
export function executeTool(
  deps: ToolDeps,
  agent: string,
  toolName: string,
  argumentsJson: string,
  roundId: number | null,
): ToolOutcome {
  const at = deps.now();
  const parsed = parseArguments(argumentsJson);
  if (!parsed.ok && !NO_ARGUMENT_TOOLS.has(toolName)) {
    return fail(parsed.error);
  }
  const args = parsed.ok ? parsed.value : {};

  switch (toolName) {
    case 'get_status': {
      const status = readBodyStatus(deps.ledger, deps.values, agent, at);
      return ok({
        satiety: Number(status.satiety.toFixed(3)),
        satietyMax: status.satietyMax,
        balance: Number(status.balance.toFixed(3)),
        mealPrice: status.mealPrice,
        satietyPerMeal: status.satietyPerMeal,
      });
    }
    case 'eat': {
      const outcome = eat(deps.ledger, deps.values, agent, at);
      if (!outcome.ok) {
        deps.blackbox.append(agent, 'meal_refused', at, roundId, {
          balance: outcome.balance,
          price: outcome.price,
        });
        return {
          content: JSON.stringify({
            ok: false,
            error: 'insufficient_balance',
            balance: Number(outcome.balance.toFixed(3)),
            price: outcome.price,
            missing: Number(outcome.missing.toFixed(3)),
            satiety: Number(outcome.satiety.toFixed(3)),
          }),
          isError: false,
        };
      }
      deps.blackbox.append(agent, 'meal', at, roundId, {
        price: outcome.price,
        gained: outcome.gained,
        overflow: outcome.overflow,
        satiety: outcome.satiety,
        balance: outcome.balance,
      });
      return ok({
        satiety: Number(outcome.satiety.toFixed(3)),
        satietyMax: outcome.satietyMax,
        balance: Number(outcome.balance.toFixed(3)),
        gained: Number(outcome.gained.toFixed(3)),
        overflow: Number(outcome.overflow.toFixed(3)),
        price: outcome.price,
      });
    }
    case 'list_tasks': {
      const board = listBoardTasks(deps.ledger, agent);
      return ok({
        open: board.open.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          price: task.price,
        })),
        mine: board.mine.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          price: task.price,
          status: task.status,
        })),
      });
    }
    case 'claim_task': {
      const taskId = readStringArg(args, 'task_id');
      if (taskId === null) {
        return fail('task_id must be a string');
      }
      const result = claimTask(deps.ledger, agent, taskId, at);
      if (!result.ok) {
        return { content: JSON.stringify({ ok: false, error: result.code }), isError: false };
      }
      deps.blackbox.append(agent, 'task_claimed', at, roundId, { taskId });
      return ok({ task: { id: result.task.id, title: result.task.title, price: result.task.price, status: result.task.status } });
    }
    case 'submit_task': {
      const taskId = readStringArg(args, 'task_id');
      const deliverable = readStringArg(args, 'deliverable');
      if (taskId === null || deliverable === null) {
        return fail('task_id and deliverable must both be strings');
      }
      const result = submitTask(deps.ledger, agent, taskId, deliverable, at);
      if (!result.ok) {
        return { content: JSON.stringify({ ok: false, error: result.code }), isError: false };
      }
      deps.blackbox.append(agent, 'task_submitted', at, roundId, {
        taskId,
        deliverable,
      });
      return ok({ task: { id: result.task.id, status: result.task.status } });
    }
    case 'report_income': {
      const where = readStringArg(args, 'where');
      const work = readStringArg(args, 'work');
      const amount = readNumberArg(args, 'amount');
      const currency = readStringArg(args, 'currency');
      if (where === null || work === null || amount === null || currency === null) {
        return fail('where, work, amount and currency are all required');
      }
      const result = reportIncome(deps.ledger, agent, { where, work, amount, currency }, at);
      if (!result.ok) {
        return { content: JSON.stringify({ ok: false, error: result.code }), isError: false };
      }
      deps.blackbox.append(agent, 'income_reported', at, roundId, {
        reportId: result.report.id,
        where,
        work,
        amount,
        currency,
      });
      return ok({ report_id: result.report.id, status: result.report.status });
    }
    case 'message_operator': {
      const text = readStringArg(args, 'text');
      if (text === null || text.trim() === '') {
        return fail('text must be a non-empty string');
      }
      const id = deps.ledger.appendMessage(agent, OPERATOR, text, at);
      deps.blackbox.append(agent, 'message_to_operator', at, roundId, { messageId: id, text });
      return ok({ message_id: id });
    }
    case 'notebook_list': {
      try {
        const files = listNotebook(deps.paths, agent);
        return ok({ files });
      } catch (error) {
        return notebookFailure(error);
      }
    }
    case 'notebook_read': {
      const path = readStringArg(args, 'path');
      if (path === null) {
        return fail('path must be a string');
      }
      try {
        const content = readNotebookFile(deps.paths, agent, path);
        return ok({ path, content });
      } catch (error) {
        return notebookFailure(error);
      }
    }
    case 'notebook_write': {
      const path = readStringArg(args, 'path');
      const content = readStringArg(args, 'content');
      if (path === null || content === null) {
        return fail('path and content must both be strings');
      }
      try {
        const stored = writeNotebookFile(deps.paths, agent, path, content);
        return ok({ path: stored, bytes: Buffer.byteLength(content, 'utf8') });
      } catch (error) {
        return notebookFailure(error);
      }
    }
    default:
      return fail(`unknown tool: ${toolName}`);
  }
}

function notebookFailure(error: unknown): ToolOutcome {
  if (error instanceof NotebookError) {
    return { content: JSON.stringify({ ok: false, error: error.code, message: error.message }), isError: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: JSON.stringify({ ok: false, error: 'notebook_failure', message }), isError: true };
}

/** The supervisor's side of one agent process. */
export interface WorkerTransport {
  send(message: ParentToChildMessage): void;
  onMessage(handler: (message: ChildToParentMessage) => void): void;
}

export interface RoundDeps {
  ledger: Ledger;
  values: ConservatoryValues;
  paths: RuntimePaths;
  blackbox: Blackbox;
  now(): number;
  memory: ModelClient | null;
  /** The editable prompt templates, loaded fresh at the start of every round. */
  prompts: PromptLibrary;
  /** Told what the prompts looked like at this wake, so the operator can be warned. */
  onPromptWarnings?(warnings: string[]): void;
  onMemoryError(agent: string, message: string): void;
}

export interface RoundOutcome {
  roundId: number;
  endReason: RoundEndReason;
  finalReply: string | null;
  error: string | null;
  memory: MemoryOutcome | null;
}

interface RoundEnd {
  endReason: RoundEndReason;
  finalReply: string | null;
  error: string | null;
}

export class RoundCoordinator {
  private readonly deps: RoundDeps;

  constructor(deps: RoundDeps) {
    this.deps = deps;
  }

  /** Everything the agent sees at the start of a round, and nothing else. */
  buildContext(agent: AgentRecord, now: number): { system: string; user: string } {
    const { ledger, values, paths } = this.deps;
    // One pass over prompts/ per wake: that is what makes an edit take effect
    // on the next round without a restart.
    const templates = this.deps.prompts.read();
    this.deps.onPromptWarnings?.(templates.warnings);

    const memory = readMemoryFile(paths, agent.name);
    const status = readBodyStatus(ledger, values, agent.name, now);
    const board = listBoardTasks(ledger, agent.name);
    const unread = ledger.listUnreadMessages(agent.name);

    const bodyState = [
      `satiety: ${formatAmount(status.satiety)} / ${status.satietyMax}`,
      `balance: ${formatAmount(status.balance)}`,
      `meal price: ${status.mealPrice} (restores ${status.satietyPerMeal} satiety)`,
    ].join('\n');

    const taskBoard: string[] = [];
    taskBoard.push('Open tasks (fixed price, first come first served):');
    if (board.open.length === 0) {
      taskBoard.push('- (none)');
    }
    for (const task of board.open) {
      taskBoard.push(`- ${task.id} | ${task.title} | price ${task.price}`);
      taskBoard.push(`  ${task.description}`);
    }
    taskBoard.push('Held by you:');
    if (board.mine.length === 0) {
      taskBoard.push('- (none)');
    }
    for (const task of board.mine) {
      taskBoard.push(`- ${task.id} | ${task.title} | price ${task.price} | status ${task.status}`);
      taskBoard.push(`  ${task.description}`);
    }

    const messages =
      unread.length === 0
        ? '(none)'
        : unread.map((message) => `- ${isoTime(message.at)}: ${message.body}`).join('\n');

    const user = renderUserContext(templates.userContext.text, {
      memory: memory.trimEnd(),
      bodyState,
      taskBoard: taskBoard.join('\n'),
      messages,
    });

    ledger.markMessagesRead(
      unread.map((message) => message.id),
      now,
    );

    return { system: templates.manual.text, user };
  }

  /** Runs one whole round, then folds it into MEMORY. */
  async run(agent: AgentRecord, worker: WorkerTransport): Promise<RoundOutcome> {
    const { ledger, blackbox } = this.deps;
    const startedAt = this.deps.now();
    const roundId = ledger.startRound(agent.name, startedAt);
    blackbox.append(agent.name, 'round_start', startedAt, roundId, { model: agent.model });

    const context = this.buildContext(agent, startedAt);
    blackbox.append(agent.name, 'context', startedAt, roundId, {
      system: context.system,
      user: context.user,
    });

    const entries: RoundTranscriptEntry[] = [];
    let settle: (value: RoundEnd) => void = () => {
      throw new Error('round end handler was not installed');
    };
    const finished = new Promise<RoundEnd>((resolve) => {
      settle = resolve;
    });

    let chain: Promise<void> = Promise.resolve();
    const handle = async (message: ChildToParentMessage): Promise<void> => {
      if (message.type === 'assistant_message') {
        entries.push({ kind: 'assistant', content: message.message.content });
        blackbox.append(agent.name, 'assistant_message', this.deps.now(), roundId, {
          message: message.message,
        });
        return;
      }
      if (message.type === 'usage') {
        const usage = message.usage;
        ledger.appendUsage({
          agent: agent.name,
          round: roundId,
          source: 'agent',
          promptTokens: usage === null ? null : usage.promptTokens,
          completionTokens: usage === null ? null : usage.completionTokens,
          at: this.deps.now(),
        });
        blackbox.append(agent.name, 'usage', this.deps.now(), roundId, {
          source: 'agent',
          promptTokens: usage === null ? null : usage.promptTokens,
          completionTokens: usage === null ? null : usage.completionTokens,
        });
        if (usage === null) {
          blackbox.append(agent.name, 'usage_missing', this.deps.now(), roundId, { source: 'agent' });
        }
        return;
      }
      if (message.type === 'tool_call') {
        entries.push({
          kind: 'tool_call',
          callId: message.callId,
          name: message.name,
          argumentsJson: message.argumentsJson,
        });
        blackbox.append(agent.name, 'tool_call', this.deps.now(), roundId, {
          callId: message.callId,
          name: message.name,
          argumentsJson: message.argumentsJson,
        });
        const outcome = executeTool(
          {
            ledger,
            values: this.deps.values,
            paths: this.deps.paths,
            blackbox,
            now: this.deps.now,
          },
          agent.name,
          message.name,
          message.argumentsJson,
          roundId,
        );
        entries.push({
          kind: 'tool_result',
          callId: message.callId,
          name: message.name,
          content: outcome.content,
          isError: outcome.isError,
        });
        blackbox.append(agent.name, 'tool_result', this.deps.now(), roundId, {
          callId: message.callId,
          name: message.name,
          content: outcome.content,
          isError: outcome.isError,
        });
        worker.send({
          type: 'tool_result',
          roundId,
          callId: message.callId,
          content: outcome.content,
          isError: outcome.isError,
        });
        return;
      }
      if (message.type === 'round_end') {
        blackbox.append(agent.name, 'round_end', this.deps.now(), roundId, {
          endReason: message.endReason,
          finalReply: message.finalReply,
          error: message.error,
        });
        settle({
          endReason: message.endReason,
          finalReply: message.finalReply,
          error: message.error,
        });
        return;
      }
      if (message.type === 'worker_log') {
        blackbox.append(agent.name, 'worker_log', this.deps.now(), roundId, {
          level: message.level,
          message: message.message,
        });
        return;
      }
      blackbox.append(agent.name, 'worker_note', this.deps.now(), roundId, { type: message.type });
    };

    worker.onMessage((message) => {
      chain = chain.then(() => handle(message));
    });
    try {
      worker.send({
        type: 'wake',
        roundId,
        system: context.system,
        user: context.user,
        tools: AGENT_TOOLS,
      });
    } catch (error) {
      // The agent process is gone before the round could start: end it here
      // rather than leaving a round row open forever.
      const message = error instanceof Error ? error.message : String(error);
      blackbox.append(agent.name, 'round_end', this.deps.now(), roundId, {
        endReason: 'model_error',
        finalReply: null,
        error: message,
      });
      settle({ endReason: 'model_error', finalReply: null, error: message });
    }

    const ended = await finished;
    await chain;
    const endedAt = this.deps.now();
    ledger.endRound(roundId, endedAt, ended.endReason);

    const transcript: RoundTranscript = {
      roundId,
      agent: agent.name,
      startedAt,
      endedAt,
      endReason: ended.endReason,
      finalReply: ended.finalReply,
      entries,
    };

    let memory: MemoryOutcome | null = null;
    if (this.deps.memory !== null) {
      memory = await consolidateMemory(
        {
          ledger,
          blackbox,
          paths: this.deps.paths,
          capChars: this.deps.values.memoryCapChars,
          model: this.deps.memory,
          systemPrompt: this.deps.prompts.memorySystem().text,
          now: this.deps.now,
          onError: this.deps.onMemoryError,
        },
        transcript,
      );
    }

    return {
      roundId,
      endReason: ended.endReason,
      finalReply: ended.finalReply,
      error: ended.error,
      memory,
    };
  }
}
