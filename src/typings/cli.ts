import type { Readable, Writable } from "node:stream";

/** Persisted or command-line configuration accepted by the WallE CLI. */
export interface AgentCliConfig {
  /** Complete Responses API-compatible model endpoint. */
  baseUrl?: string;
  /** Provider model identifier. */
  model?: string;
  /** Bearer API key sent to the model endpoint. */
  apiKey?: string;
  /** System instructions injected into every model call. */
  instruction?: string;
  /** Existing session identifier to restore. */
  session?: string;
  /** Whether session logging is enabled. */
  log?: boolean;
}

/** Fully validated configuration required to start the WallE CLI. */
export interface ResolvedAgentCliConfig extends AgentCliConfig {
  /** Complete Responses API-compatible model endpoint. */
  baseUrl: string;
  /** Provider model identifier. */
  model: string;
  /** Bearer API key sent to the model endpoint. */
  apiKey: string;
  /** Whether session logging is enabled. */
  log: boolean;
}

/** Injectable process resources used by the CLI runtime and its tests. */
export interface AgentCliRuntime {
  /** Working directory containing `.walle`, `WALLE.md`, sessions, and logs. */
  cwd: string;
  /** Stream from which interactive user requests are read. */
  input: Readable;
  /** Stream receiving prompts and model output. */
  output: Writable;
  /** Fetch implementation used for model API requests. */
  fetch: typeof fetch;
  /** Optional clock used to measure streamed reasoning duration. */
  now?: () => number;
}
