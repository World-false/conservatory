import { existsSync, mkdirSync } from 'node:fs';

import type { AgentRecord } from '../organs/ledger';
import type {
  ChildToParentMessage,
  ParentToChildMessage,
  RoundEndReason,
  RoundTranscript,
  RoundTranscriptEntry,
  ToolSchema,
} from '../agent/ipc';
import {
  agentHomeDir,
  agentMemoryPath,
  agentNotebookDir,
  type ConservatoryValues,
  type RuntimePaths,
} from '../config';
import type { ModelClient } from '../model/client';
import type { Blackbox } from '../organs/blackbox';
import { listWoundViews, treat } from '../organs/clinic';
import { reportIncome } from '../organs/income';
import type { Ledger, TransferBalanceResult, TreatmentTier } from '../organs/ledger';
import { consolidateMemory, isoTime, readMemoryFile, type MemoryOutcome } from '../organs/memory';
import { eat, formatAmount, readBodyStatus } from '../organs/metabolism';
import { listLivingOtherAgents } from '../organs/population';
import { renderRoundContext, type PromptLibrary } from '../organs/prompts';
import {
  listNotebook,
  NotebookError,
  readNotebookFile,
  writeNotebookFile,
} from '../organs/notebook';
import { executeSandboxedCommand, SandboxError, type SandboxShell } from '../organs/sandbox';
import type { SandboxPolicyStore } from '../organs/sandbox/policy';
import { claimTask, listBoardTasks, submitTask } from '../organs/taskboard';

export const OPERATOR = 'operator';

/** The complete tool set of step 1, plus the social tools of step 4. */
export const AGENT_TOOLS: ToolSchema[] = [
  {
    name: 'get_status',
    description:
      'Returns your current body state: satiety, the satiety ceiling, your balance, the price of one meal, how much satiety a meal restores, how many untreated redacted characters you carry toward the death line, and both treatment prices.',
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
  {
    name: 'list_wounds',
    description:
      'Lists the wounds in your MEMORY that are not fully healed yet: the id to treat, whether it is untreated or scarred, how many characters it holds, and the sentence it sits in.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'execute_command',
    description:
      'Runs a command in the Windows isolated sandbox. The working directory is inside your private notebook workspace. You can perform computations, run scripts, create files in your workspace, and access the network. Outside your workspace, writing is denied by the OS kernel.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line string to execute (e.g. in pwsh or cmd).' },
        shell: {
          type: 'string',
          enum: ['pwsh', 'cmd'],
          description: 'Shell to use (defaults to pwsh).',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'treat',
    description:
      'Treats one wound for a price. Ordinary treatment restores the characters and leaves a scar; complete treatment leaves no trace and costs more. Refused when your balance is below the price, and nothing changes then.',
    parameters: {
      type: 'object',
      properties: {
        wound_id: { type: 'integer', description: 'The id of the wound, as list_wounds reports it.' },
        tier: { type: 'string', description: 'Either "ordinary" or "complete".' },
      },
      required: ['wound_id', 'tier'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_agents',
    description: 'Lists the other living agents currently in the conservatory.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'message_agent',
    description: 'Sends a message in English to another living agent in the conservatory.',
    parameters: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'The name of the living agent to message.' },
        text: { type: 'string', description: 'The message body in English.' },
      },
      required: ['recipient', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'transfer_balance',
    description: 'Transfers balance to another living agent. Refused if your balance is insufficient.',
    parameters: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'The name of the living agent to receive the balance.' },
        amount: { type: 'number', description: 'The amount of balance to transfer.' },
      },
      required: ['recipient', 'amount'],
      additionalProperties: false,
    },
  },
];

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/** Tools that take no arguments; some providers send no arguments at all. */
const NO_ARGUMENT_TOOLS = new Set(['get_status', 'eat', 'list_tasks', 'notebook_list', 'list_wounds', 'list_agents']);

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
 * The social tools answer in plain English rather than in JSON: a refusal the
 * agent can act on (a wrong recipient, not enough money) is a normal result of
 * the call, so it carries `isError: false` exactly as a refusal from `eat` does.
 */
function plain(text: string): ToolOutcome {
  return { content: text, isError: false };
}

/** One English sentence per refusal reason the ledger can return. */
function transferRefusal(reason: Extract<TransferBalanceResult, { ok: false }>['reason']): string {
  switch (reason) {
    case 'insufficient_balance':
      return 'Insufficient balance: you cannot afford this transfer.';
    case 'recipient_not_found':
      return 'Recipient not found.';
    case 'recipient_not_alive':
      return 'Recipient is not alive.';
    case 'invalid_amount':
      return 'Amount must be a positive number.';
    case 'self_transfer':
      return 'You cannot transfer balance to yourself.';
    case 'sender_not_found':
      return 'Sender not found.';
    case 'sender_not_alive':
      return 'Sender is not alive.';
    default:
      return 'The transfer was refused.';
  }
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

  try {
    switch (toolName) {
      case 'get_status': {
        const status = readBodyStatus(deps.ledger, deps.values, agent, at);
        return ok({
          satiety: Number(status.satiety.toFixed(3)),
          satietyMax: status.satietyMax,
          balance: Number(status.balance.toFixed(3)),
          mealPrice: status.mealPrice,
          satietyPerMeal: status.satietyPerMeal,
          untreatedRedactedChars: deps.ledger.untreatedRedactedChars(agent),
          deathLineChars: deps.values.deathLineChars,
          ordinaryTreatmentPrice: deps.values.ordinaryTreatmentPrice,
          completeTreatmentPrice: deps.values.completeTreatmentPrice,
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
      case 'list_wounds': {
        return ok({ wounds: listWoundViews(deps, agent) });
      }
      case 'treat': {
        const woundId = readNumberArg(args, 'wound_id');
        const tierArg = readStringArg(args, 'tier');
        if (woundId === null || !Number.isInteger(woundId)) {
          return fail('wound_id must be an integer');
        }
        if (tierArg !== 'ordinary' && tierArg !== 'complete') {
          return fail('tier must be "ordinary" or "complete"');
        }
        const tier: TreatmentTier = tierArg;
        const outcome = treat(deps, agent, woundId, tier, 'agent');
        if (!outcome.ok) {
          deps.blackbox.append(agent, 'treatment_refused', at, roundId, {
            woundId,
            tier,
            code: outcome.code,
          });
          return {
            content: JSON.stringify({
              ok: false,
              error: outcome.code,
              balance: Number(outcome.balance.toFixed(3)),
              price: outcome.price,
              missing: Number(outcome.missing.toFixed(3)),
            }),
            isError: false,
          };
        }
        return ok({
          wound_id: outcome.wound.id,
          status: outcome.wound.status,
          tier: outcome.tier,
          price: outcome.price,
          balance: Number(deps.ledger.getBalance(agent).toFixed(3)),
          untreatedRedactedChars: deps.ledger.untreatedRedactedChars(agent),
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
      case 'list_agents': {
        const others = listLivingOtherAgents(deps.ledger, agent);
        deps.blackbox.append(agent, 'list_agents', at, null, { count: others.length });
        if (others.length === 0) {
          return plain('There are no other living agents in the conservatory.');
        }
        return plain(others.map((other) => `- ${other.name}`).join('\n'));
      }
      case 'message_agent': {
        const recipient = readStringArg(args, 'recipient');
        const text = readStringArg(args, 'text');
        if (recipient === null || text === null) {
          return fail('recipient and text must both be strings');
        }
        if (recipient === agent) {
          return plain('You cannot message yourself.');
        }
        if (text.trim() === '') {
          return plain('Message text cannot be empty.');
        }
        const target = deps.ledger.getAgent(recipient);
        if (target === null) {
          return plain(`Agent "${recipient}" does not exist.`);
        }
        if (target.status !== 'alive') {
          return plain(`Agent "${recipient}" is not alive.`);
        }
        deps.ledger.appendMessage(agent, recipient, text.trim(), at);
        deps.blackbox.append(agent, 'message_agent', at, null, { recipient, text: text.trim() });
        return plain(`Message sent to ${recipient}.`);
      }
      case 'transfer_balance': {
        const recipient = readStringArg(args, 'recipient');
        const amount = readNumberArg(args, 'amount');
        if (recipient === null) {
          return fail('recipient must be a string');
        }
        if (amount === null || !Number.isFinite(amount) || amount <= 0) {
          return plain('Amount must be a positive number.');
        }
        if (recipient === agent) {
          return plain('You cannot transfer balance to yourself.');
        }
        const result = deps.ledger.transferBalance(agent, recipient, amount, at);
        if (!result.ok) {
          return plain(transferRefusal(result.reason));
        }
        deps.blackbox.append(agent, 'transfer_out', at, null, { recipient, amount });
        deps.blackbox.append(recipient, 'transfer_in', at, null, { sender: agent, amount });
        return plain(
          `Transferred ${formatAmount(amount)} balance to ${recipient}. Your balance is now ${formatAmount(result.senderBalance)}.`,
        );
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
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function notebookFailure(error: unknown): ToolOutcome {
  if (error instanceof NotebookError) {
    return { content: JSON.stringify({ ok: false, error: error.code, message: error.message }), isError: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: JSON.stringify({ ok: false, error: 'notebook_failure', message }), isError: true };
}

/** What `execute_command` needs: the agent's paths, the black box, and the policy. */
export interface CommandToolDeps {
  ledger: Ledger;
  paths: RuntimePaths;
  blackbox: Blackbox;
  sandbox: SandboxPolicyStore;
  now(): number;
}

/**
 * Runs `execute_command`: the agent's own working directory, the operator's
 * live sandbox policy, and one denied-or-allowed answer from the OS kernel.
 * Everything the command did is appended to the black box before the model
 * sees the result, so the record never depends on the model's own account.
 */
async function executeCommandTool(
  deps: CommandToolDeps,
  agent: string,
  argumentsJson: string,
  roundId: number,
): Promise<ToolOutcome> {
  const at = deps.now();
  try {
    const parsed = parseArguments(argumentsJson);
    if (!parsed.ok) {
      return fail(parsed.error);
    }
    const command = readStringArg(parsed.value, 'command');
    if (command === null || command.trim() === '') {
      return fail('command must be a non-empty string');
    }
    const shellArg = readStringArg(parsed.value, 'shell');
    if (shellArg !== null && shellArg !== 'pwsh' && shellArg !== 'cmd') {
      return fail('shell must be "pwsh" or "cmd"');
    }
    const shell: SandboxShell = shellArg === 'cmd' ? 'cmd' : 'pwsh';

    const homeDir = agentHomeDir(deps.paths, agent);
    const notebookDir = agentNotebookDir(deps.paths, agent);
    const memoryPath = agentMemoryPath(deps.paths, agent);
    mkdirSync(notebookDir, { recursive: true });
    const policy = deps.sandbox.resolve({
      name: agent,
      homeDir,
      notebookDir,
      memoryPath,
    });

    try {
      const result = await executeSandboxedCommand({
        command,
        cwd: notebookDir,
        writableDirs: policy.writableDirs,
        readMode: policy.readMode,
        readBlacklist: policy.readBlacklist,
        readWhitelist: policy.readWhitelist,
        readOnlyFiles: policy.readOnlyFiles,
        whitelistRoot: policy.whitelistRoot,
        timeoutMs: policy.commandTimeoutSeconds * 1000,
        maxOutputChars: policy.maxOutputChars,
        shell,
      });
      deps.blackbox.append(agent, 'command_executed', at, roundId, {
        command,
        shell,
        cwd: notebookDir,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      return {
        content: JSON.stringify({
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        }),
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof SandboxError ? error.code : 'sandbox_failure';
      deps.blackbox.append(agent, 'command_refused', at, roundId, { command, shell, code, message });
      return { content: JSON.stringify({ ok: false, error: code, message }), isError: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.blackbox.append(agent, 'command_refused', at, roundId, { code: 'sandbox_failure', message });
    return fail(message);
  }
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
  /** The live sandbox policy the console edits and `execute_command` reads. */
  sandbox: SandboxPolicyStore;
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
    const unread = ledger.listUnreadMessages(agent.name);

    const bodyState = [
      `satiety: ${formatAmount(status.satiety)} / ${status.satietyMax}`,
      `balance: ${formatAmount(status.balance)}`,
      `meal price: ${status.mealPrice} (restores ${status.satietyPerMeal} satiety)`,
      `untreated redacted characters: ${ledger.untreatedRedactedChars(agent.name)} / death line ${values.deathLineChars}`,
      `wounds not fully healed: ${ledger.listWounds(agent.name).filter((wound) => wound.status !== 'healed').length}`,
      `treatment prices: ordinary ${values.ordinaryTreatmentPrice}, complete ${values.completeTreatmentPrice}`,
    ].join('\n');

    // The inbox holds two different things, and the agent must not have to
    // guess which one it is reading: what the harness did to its body, and what
    // someone said to it.
    const systemMsgs = unread.filter((message) => message.sender === 'system');
    const chatMsgs = unread.filter((message) => message.sender !== 'system');

    const systemReminders =
      systemMsgs.length === 0 ? '(none)' : systemMsgs.map((message) => `- ${message.body}`).join('\n');

    const messages =
      chatMsgs.length === 0
        ? '(none)'
        : chatMsgs.map((message) => `- ${isoTime(message.at)} [from ${message.sender}]: ${message.body}`).join('\n');

    // Who the agent is goes on the system side, after the manual: MEMORY and
    // the body state are read as part of its own standing description rather
    // than as something someone said to it. The task board is not injected at
    // all; the agent reads it with list_tasks when it wants it.
    const systemBlocks = {
      memory: memory.trimEnd(),
      bodyState,
      systemReminders,
      messages,
    };
    const system = [templates.manual.text, renderRoundContext(templates.systemContext.text, systemBlocks)].join(
      '\n\n',
    );

    const user = renderRoundContext(templates.userContext.text, systemBlocks);

    ledger.markMessagesRead(
      unread.map((message) => message.id),
      now,
    );

    return { system, user };
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
        const outcome =
          message.name === 'execute_command'
            ? await executeCommandTool(
                {
                  ledger,
                  paths: this.deps.paths,
                  blackbox,
                  sandbox: this.deps.sandbox,
                  now: this.deps.now,
                },
                agent.name,
                message.argumentsJson,
                roundId,
              )
            : executeTool(
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
      // Defense in depth: `handle` is not supposed to throw, but if anything
      // ever escapes it the rejection would otherwise be unhandled, which took
      // the whole supervisor process down and left this round row open. Record
      // it and settle the round instead, so the promise always settles.
      chain = chain.then(() => handle(message)).catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        blackbox.append(agent.name, 'round_error', this.deps.now(), roundId, { error: text });
        settle({ endReason: 'model_error', finalReply: null, error: text });
      });
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
