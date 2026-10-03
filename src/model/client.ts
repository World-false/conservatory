import OpenAI from 'openai';
import type {
  SerializedMessage,
  SerializedToolCall,
  TokenUsage,
  ToolSchema,
} from '../agent/ipc';
import type { ModelSettings } from '../config';

export class ModelRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

export interface ChatRequest {
  messages: readonly SerializedMessage[];
  tools?: readonly ToolSchema[];
}

export interface ChatResponse {
  message: SerializedMessage;
  /** null means the provider reported no usage. Never guessed, never estimated. */
  usage: TokenUsage | null;
}

export interface ModelClient {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export function toSdkMessages(
  messages: readonly SerializedMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      out.push({ role: message.role, content: message.content ?? '' });
      continue;
    }
    if (message.role === 'assistant') {
      const calls = message.toolCalls ?? [];
      if (calls.length === 0) {
        out.push({ role: 'assistant', content: message.content ?? '' });
        continue;
      }
      out.push({
        role: 'assistant',
        content: message.content,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.argumentsJson },
        })),
      });
      continue;
    }
    if (message.toolCallId === undefined) {
      throw new ModelRequestError('a tool message is missing its tool_call_id');
    }
    out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' });
  }
  return out;
}

export function toSdkTools(
  tools: readonly ToolSchema[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function extractUsage(raw: OpenAI.Completions.CompletionUsage | undefined): TokenUsage | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw.prompt_tokens !== 'number' || typeof raw.completion_tokens !== 'number') {
    return null;
  }
  return { promptTokens: raw.prompt_tokens, completionTokens: raw.completion_tokens };
}

function extractToolCalls(
  raw: readonly OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] | undefined,
): SerializedToolCall[] {
  if (raw === undefined) {
    return [];
  }
  const calls: SerializedToolCall[] = [];
  for (const call of raw) {
    if (call.type !== 'function') {
      throw new ModelRequestError(`unsupported tool call type from the provider: ${call.type}`);
    }
    calls.push({ id: call.id, name: call.function.name, argumentsJson: call.function.arguments });
  }
  return calls;
}

/**
 * The only implementation of ModelClient: an OpenAI-compatible chat endpoint.
 * The timeout comes from the configuration, so a stalled provider cannot hold
 * a round open forever.
 */
export class OpenAICompatibleClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(settings: ModelSettings, requestTimeoutMs: number) {
    this.client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      timeout: requestTimeoutMs,
    });
    this.model = settings.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const tools = request.tools === undefined ? undefined : toSdkTools(request.tools);
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        messages: toSdkMessages(request.messages),
        ...(tools === undefined ? {} : { tools }),
      });
    } catch (error) {
      throw new ModelRequestError(describeRequestFailure(error));
    }
    const choice = completion.choices[0];
    if (choice === undefined) {
      throw new ModelRequestError('the provider returned no choices');
    }
    const calls = extractToolCalls(choice.message.tool_calls);
    const message: SerializedMessage = {
      role: 'assistant',
      content: choice.message.content ?? null,
      ...(calls.length === 0 ? {} : { toolCalls: calls }),
    };
    return { message, usage: extractUsage(completion.usage) };
  }
}

function describeRequestFailure(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    return `provider error ${error.status}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
