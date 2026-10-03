import { OpenAICompatibleClient, type ModelClient } from '../model/client';
import type {
  ChildToParentMessage,
  JsonSchemaProperty,
  JsonSchemaPropertyType,
  ParentToChildMessage,
  RoundEndReason,
  SerializedMessage,
  TokenUsage,
  ToolSchema,
} from './ipc';

/** A model that never stops calling tools must not hold a round open forever. */
export const MAX_TOOL_ITERATIONS = 50;

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export type ModelLoopEvent =
  | { type: 'assistant_message'; message: SerializedMessage }
  | { type: 'usage'; usage: TokenUsage | null }
  | { type: 'round_end'; endReason: RoundEndReason; finalReply: string | null; error: string | null };

export interface ModelLoopOptions {
  client: ModelClient;
  system: string;
  user: string;
  tools: readonly ToolSchema[];
  roundContextCapTokens: number;
  /** Sends the call to the supervisor, which owns every tool and every file. */
  requestTool(callId: string, name: string, argumentsJson: string): Promise<ToolOutcome>;
  emit(event: ModelLoopEvent): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The agent's model loop. It lives in the worker process and touches nothing
 * but the model: every tool call goes back to the supervisor over IPC.
 */
export async function runModelLoop(options: ModelLoopOptions): Promise<void> {
  const messages: SerializedMessage[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.user },
  ];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    let response;
    try {
      response = await options.client.chat({ messages, tools: options.tools });
    } catch (error) {
      options.emit({
        type: 'round_end',
        endReason: 'model_error',
        finalReply: null,
        error: messageOf(error),
      });
      return;
    }

    options.emit({ type: 'assistant_message', message: response.message });
    options.emit({ type: 'usage', usage: response.usage });

    if (response.usage === null) {
      options.emit({
        type: 'round_end',
        endReason: 'usage_missing',
        finalReply: null,
        error: 'the provider reported no usage for this response',
      });
      return;
    }
    if (response.usage.promptTokens > options.roundContextCapTokens) {
      options.emit({
        type: 'round_end',
        endReason: 'context_cap',
        finalReply: null,
        error: `prompt tokens ${response.usage.promptTokens} exceeded the round cap of ${options.roundContextCapTokens}`,
      });
      return;
    }

    const calls = response.message.toolCalls ?? [];
    messages.push(response.message);
    if (calls.length === 0) {
      options.emit({
        type: 'round_end',
        endReason: 'final',
        finalReply: response.message.content ?? '',
        error: null,
      });
      return;
    }

    for (const call of calls) {
      let outcome: ToolOutcome;
      try {
        outcome = await options.requestTool(call.id, call.name, call.argumentsJson);
      } catch (error) {
        outcome = {
          content: JSON.stringify({ ok: false, error: `tool transport failed: ${messageOf(error)}` }),
          isError: true,
        };
      }
      messages.push({ role: 'tool', toolCallId: call.id, content: outcome.content });
    }
  }

  options.emit({
    type: 'round_end',
    endReason: 'iteration_cap',
    finalReply: null,
    error: `the model kept calling tools past ${MAX_TOOL_ITERATIONS} steps`,
  });
}

// ---------------------------------------------------------------- process IPC

interface WorkerRuntime {
  handleMessage(message: ParentToChildMessage): void;
}

export function createWorkerRuntime(send: (message: ChildToParentMessage) => void): WorkerRuntime {
  let client: ModelClient | null = null;
  let cap = 0;
  let activeRound: number | null = null;
  const pending = new Map<string, (outcome: ToolOutcome) => void>();

  function finishRound(
    roundId: number,
    endReason: RoundEndReason,
    finalReply: string | null,
    error: string | null,
  ): void {
    activeRound = null;
    send({ type: 'round_end', roundId, endReason, finalReply, error });
  }

  async function runRound(
    roundId: number,
    system: string,
    user: string,
    tools: readonly ToolSchema[],
  ): Promise<void> {
    if (client === null) {
      finishRound(roundId, 'model_error', null, 'the worker was never initialized');
      return;
    }
    activeRound = roundId;
    await runModelLoop({
      client,
      system,
      user,
      tools,
      roundContextCapTokens: cap,
      requestTool: (callId, name, argumentsJson) =>
        new Promise<ToolOutcome>((resolve) => {
          pending.set(callId, resolve);
          send({ type: 'tool_call', roundId, callId, name, argumentsJson });
        }),
      emit: (event) => {
        if (event.type === 'assistant_message') {
          send({ type: 'assistant_message', roundId, message: event.message });
          return;
        }
        if (event.type === 'usage') {
          send({ type: 'usage', roundId, usage: event.usage });
          return;
        }
        finishRound(roundId, event.endReason, event.finalReply, event.error);
      },
    });
  }

  return {
    handleMessage(message: ParentToChildMessage): void {
      if (message.type === 'init') {
        client = new OpenAICompatibleClient(message.model);
        cap = message.roundContextCapTokens;
        return;
      }
      if (message.type === 'shutdown') {
        process.exit(0);
      }
      if (message.type === 'wake') {
        if (activeRound !== null) {
          finishRound(
            message.roundId,
            'model_error',
            null,
            `round ${activeRound} is still running in this worker`,
          );
          return;
        }
        void runRound(message.roundId, message.system, message.user, message.tools);
        return;
      }
      const resolve = pending.get(message.callId);
      if (resolve === undefined) {
        send({
          type: 'worker_log',
          level: 'error',
          message: `a tool result arrived for an unknown call: ${message.callId}`,
        });
        return;
      }
      pending.delete(message.callId);
      resolve({ content: message.content, isError: message.isError });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PROPERTY_TYPES: readonly JsonSchemaPropertyType[] = ['string', 'number', 'integer', 'boolean'];

function parseToolSchema(value: unknown): ToolSchema | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = value['name'];
  const description = value['description'];
  const parameters = value['parameters'];
  if (typeof name !== 'string' || typeof description !== 'string' || !isRecord(parameters)) {
    return null;
  }
  if (parameters['type'] !== 'object' || parameters['additionalProperties'] !== false) {
    return null;
  }
  const rawProperties = parameters['properties'];
  if (!isRecord(rawProperties)) {
    return null;
  }
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const [key, rawProperty] of Object.entries(rawProperties)) {
    if (!isRecord(rawProperty)) {
      return null;
    }
    const type = rawProperty['type'];
    const propertyDescription = rawProperty['description'];
    if (typeof type !== 'string' || typeof propertyDescription !== 'string') {
      return null;
    }
    const matched = PROPERTY_TYPES.find((candidate) => candidate === type);
    if (matched === undefined) {
      return null;
    }
    properties[key] = { type: matched, description: propertyDescription };
  }
  const rawRequired = parameters['required'];
  if (!Array.isArray(rawRequired)) {
    return null;
  }
  const required: string[] = [];
  for (const entry of rawRequired) {
    if (typeof entry !== 'string') {
      return null;
    }
    required.push(entry);
  }
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function parseParentMessage(raw: unknown): ParentToChildMessage | null {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') {
    return null;
  }
  const type = raw['type'];
  if (type === 'init') {
    const model = raw['model'];
    const cap = raw['roundContextCapTokens'];
    if (!isRecord(model) || typeof cap !== 'number') {
      return null;
    }
    if (
      typeof model['baseUrl'] !== 'string' ||
      typeof model['apiKey'] !== 'string' ||
      typeof model['model'] !== 'string'
    ) {
      return null;
    }
    return {
      type: 'init',
      model: { baseUrl: model['baseUrl'], apiKey: model['apiKey'], model: model['model'] },
      roundContextCapTokens: cap,
    };
  }
  if (type === 'wake') {
    const roundId = raw['roundId'];
    const system = raw['system'];
    const user = raw['user'];
    const tools = raw['tools'];
    if (typeof roundId !== 'number' || typeof system !== 'string' || typeof user !== 'string') {
      return null;
    }
    if (!Array.isArray(tools)) {
      return null;
    }
    const parsedTools: ToolSchema[] = [];
    for (const tool of tools) {
      const parsed = parseToolSchema(tool);
      if (parsed === null) {
        return null;
      }
      parsedTools.push(parsed);
    }
    return { type: 'wake', roundId, system, user, tools: parsedTools };
  }
  if (type === 'tool_result') {
    const roundId = raw['roundId'];
    const callId = raw['callId'];
    const content = raw['content'];
    const isError = raw['isError'];
    if (
      typeof roundId !== 'number' ||
      typeof callId !== 'string' ||
      typeof content !== 'string' ||
      typeof isError !== 'boolean'
    ) {
      return null;
    }
    return { type: 'tool_result', roundId, callId, content, isError };
  }
  if (type === 'shutdown') {
    return { type: 'shutdown' };
  }
  return null;
}

export function startWorkerProcess(): void {
  const send = (message: ChildToParentMessage): void => {
    process.send?.(message);
  };
  const runtime = createWorkerRuntime(send);
  process.on('message', (raw: unknown) => {
    const message = parseParentMessage(raw);
    if (message === null) {
      send({
        type: 'worker_log',
        level: 'error',
        message: 'the worker received a message it could not read',
      });
      return;
    }
    runtime.handleMessage(message);
  });
  // If the supervisor goes away, this agent's process goes with it.
  process.on('disconnect', () => {
    process.exit(0);
  });
  send({ type: 'ready', pid: process.pid });
}

// Only a forked worker has an IPC channel; importing this module in tests does nothing.
if (process.send !== undefined) {
  startWorkerProcess();
}
