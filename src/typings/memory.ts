import type { ConversationItem } from "./conversation.js";

/** Metadata describing the Agent task that produced a memory update. */
export interface MemoryContextMetadata {
  /** Model identifier used for the task. */
  model: string;
  /** Unix timestamp in milliseconds at which the task started. */
  startedAt: number;
  /** Unix timestamp in milliseconds at which the task finished. */
  completedAt: number;
}

/** The task-local conversation context forwarded to memory adapters. */
export interface MemoryContext {
  /** Conversation identity and items produced during the current task only. */
  conversation: {
    /** Stable identity of the owning conversation. */
    id: string;
    /** Items from the current user request through task termination. */
    items: ConversationItem[];
  };
  /** Task metadata available to adapter-specific update logic. */
  metadata: MemoryContextMetadata;
}

/** A pluggable source that retrieves and updates one kind of Agent memory. */
export interface MemoryAdapter {
  /** Unique adapter name selected by the model. */
  readonly name: string;
  /** Human-readable guidance explaining when the adapter should be used. */
  readonly description: string;
  /**
   * Retrieves memory relevant to a model-generated query.
   * @param query Search expression selected by the model.
   * @returns Adapter-specific memory content suitable for tool output.
   */
  retrieve(query: string): unknown | Promise<unknown>;
  /**
   * Processes one completed task's local conversation context.
   * @param context Conversation items and task metadata to persist or index.
   * @returns Completion of the adapter update.
   */
  update(context: MemoryContext): void | Promise<void>;
}

/** Parsed arguments accepted by the built-in memory retrieval tool. */
export interface MemoryRetrieveArguments {
  /** Registered adapter name. */
  name: string;
  /** Search expression passed to the selected adapter. */
  query: string;
}
