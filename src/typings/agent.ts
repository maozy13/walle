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
  /** Existing session identifier to load when the agent is constructed. */
  sessionId?: string;
}

/** Input accepted by a WallE model query. */
export type AgentInput = string | InputItem[];

/** Optional settings accepted by a WallE model query. */
export type AgentQueryOptions = Optional;

/** Base payload shared by all WallE response events. */
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

/** Event emitted when response output is added or changed. */
export interface AgentResponseChanged extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.response.changed";
}

/** Event emitted when a model response completes. */
export interface AgentResponseCompleted extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.response.completed";
}

/** Event emitted when a model response fails. */
export interface AgentResponseFailed extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.response.failed";
}

/** Event emitted when a model response ends before completion. */
export interface AgentResponseIncomplete extends AgentResponseEventBase {
  /** Stable event discriminator. */
  type: "agent.response.incomplete";
}

/** Any event emitted by a WallE agent query. */
export type AgentEvent =
  | AgentResponseCreated
  | AgentResponseChanged
  | AgentResponseCompleted
  | AgentResponseFailed
  | AgentResponseIncomplete;

/** Event stream returned by a WallE model query. */
export type AgentQuery = AsyncGenerator<AgentEvent, Response>;
