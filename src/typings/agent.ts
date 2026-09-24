import type { Connector, InputItem, Optional, Response } from "@maozy13/neuralink";
import type { Conversation } from "../conversation.js";
import type { Tools } from "../tools/tools.js";
import type { Memory } from "../memory.js";

/** Options used to create a WallE agent. */
export interface AgentOptions {
  /** NeuralLink connector used for every model request. */
  llm: Pick<Connector<unknown, unknown>, "call">;
  /** System instructions injected into every NeuralLink model call. */
  instructions?: string;
  /** Optional conversation container; a new empty conversation is used by default. */
  conversation?: Conversation;
  /** Optional tool registry; the default registry contains the built-in bash tool. */
  tools?: Tools;
  /** Memory whose adapters are exposed as one tool when the Agent is constructed. */
  memory?: Memory;
  /** Working directory used by built-in tools and skill discovery. */
  cwd?: string;
  /** User home directory used to discover user-level skill packages. */
  home?: string;
  /** Existing session identifier to load when the agent is constructed. */
  sessionId?: string;
}

/** Input accepted by a WallE model query. */
export type AgentInput = string | InputItem[];

/** Optional settings accepted by a WallE model query. */
export type AgentQueryOptions = Optional;

/** Event emitted once when an Agent task starts. */
export interface AgentRunCreated {
  /** Stable event discriminator. */
  type: "agent.run.created";
  /** Stable identifier shared by every model round in this Agent task. */
  run_id: string;
}

/** Base payload shared by WallE events that contain a model response. */
export interface AgentResponseEventBase {
  /** Model response identifier, or an empty string when the provider omits it. */
  id: string;
  /** Response state accumulated when the event was emitted. */
  response: Response;
}

/** Event emitted when a model response is initialized. */
export interface AgentResponseCreated extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.response.created";
}

/** Event emitted when the reasoning output changes. */
export interface AgentReasoningChanged extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.reasoning.changed";
}

/** Event emitted when the assistant message output changes. */
export interface AgentMessageChanged extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.message.changed";
}

/** Event emitted when a completed response requests a function tool. */
export interface AgentFunctionCallCompleted extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.function_call.completed";
}

/** Event emitted when a completed response requests a custom tool. */
export interface AgentCustomToolCallCompleted extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.custom_tool_call.completed";
}

/** Event emitted when an Agent task completes without another tool round. */
export interface AgentRunCompleted extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.run.completed";
}

/** Event emitted when an Agent task fails. */
export interface AgentRunFailed extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.run.failed";
}

/** Event emitted when an Agent task ends before completion. */
export interface AgentRunIncomplete extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.run.incomplete";
}

/** Any event emitted by a WallE agent query. */
export type AgentEvent =
  | AgentRunCreated
  | AgentResponseCreated
  | AgentReasoningChanged
  | AgentMessageChanged
  | AgentFunctionCallCompleted
  | AgentCustomToolCallCompleted
  | AgentRunCompleted
  | AgentRunFailed
  | AgentRunIncomplete;

/** Event stream returned by a WallE model query. */
export type AgentQuery = AsyncGenerator<AgentEvent, Response>;
