import type { Connector, InputItem, Optional, Response, ResponseEvent } from "neuralink";

/** Options used to create a WallE agent. */
export interface AgentOptions {
  /** NeuralLink connector used for every model request. */
  llm: Pick<Connector<unknown, unknown>, "call">;
}

/** Input accepted by a WallE model query. */
export type AgentInput = string | InputItem[];

/** Optional settings accepted by a WallE model query. */
export type AgentQueryOptions = Optional;

/** Event stream returned by a WallE model query. */
export type AgentQuery = AsyncGenerator<ResponseEvent, Response>;
