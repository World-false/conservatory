import type { ModelSettings } from '../config';

/** Token counts exactly as the provider reported them. Never estimated. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface SerializedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/**
 * One chat message in the shape the model sees. The worker only ever holds
 * these; the supervisor owns everything that touches disk or the ledger.
 */
export interface SerializedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /**
   * The model's own thinking, when the provider reports it separately from the
   * answer. It is carried for the operator to read and is never sent back to
   * the provider: a reasoning trace is not part of the conversation.
   */
  reasoningContent?: string | null;
  toolCalls?: SerializedToolCall[];
  toolCallId?: string;
}

export type JsonSchemaPropertyType = 'string' | 'number' | 'integer' | 'boolean';

export interface JsonSchemaProperty {
  type: JsonSchemaPropertyType;
  description: string;
  /** The closed set of values the model may choose from, when there is one. */
  enum?: readonly string[];
}

export interface JsonSchemaObject {
  /** JSON Schema travels as an open object; the fields below are the ones we set. */
  [key: string]: unknown;
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

/** Why a round stopped. `error` covers a model or provider failure. */
export type RoundEndReason = 'final' | 'context_cap' | 'usage_missing' | 'iteration_cap' | 'model_error';

export type ChildToParentMessage =
  | { type: 'ready'; pid: number }
  | { type: 'assistant_message'; roundId: number; message: SerializedMessage }
  | { type: 'usage'; roundId: number; usage: TokenUsage | null }
  | { type: 'tool_call'; roundId: number; callId: string; name: string; argumentsJson: string }
  | {
      type: 'round_end';
      roundId: number;
      endReason: RoundEndReason;
      finalReply: string | null;
      error: string | null;
    }
  | { type: 'worker_log'; level: 'info' | 'error'; message: string };

export type ParentToChildMessage =
  | {
      type: 'init';
      model: ModelSettings;
      roundContextCapTokens: number;
      maxToolCallsPerRound: number;
      modelRequestTimeoutSeconds: number;
    }
  | { type: 'wake'; roundId: number; system: string; user: string; tools: ToolSchema[] }
  | { type: 'tool_result'; roundId: number; callId: string; content: string; isError: boolean }
  | { type: 'shutdown' };

/** One tool result as it happened, kept for the round transcript. */
export type RoundTranscriptEntry =
  | { kind: 'assistant'; content: string | null }
  | { kind: 'tool_call'; callId: string; name: string; argumentsJson: string }
  | { kind: 'tool_result'; callId: string; name: string; content: string; isError: boolean };

/** Everything the memory system is given about one finished round. */
export interface RoundTranscript {
  roundId: number;
  agent: string;
  startedAt: number;
  endedAt: number;
  endReason: RoundEndReason;
  finalReply: string | null;
  entries: RoundTranscriptEntry[];
}
