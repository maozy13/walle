import type { Response } from "neuralink";
import type {
  AgentInput,
  AgentOptions,
  AgentQuery,
  AgentQueryOptions,
} from "./typings/agent.js";

/** Minimal WallE runtime that delegates model conversations to NeuralLink. */
export class Agent {
  private readonly llm: AgentOptions["llm"];

  /**
   * Creates an agent backed by a NeuralLink-compatible connector.
   * @param options Model connector used by the agent.
   */
  public constructor(options: AgentOptions) {
    this.llm = options.llm;
  }

  /**
   * Starts a streaming model conversation.
   * @param model Provider model identifier.
   * @param input Plain text or structured NeuralLink input.
   * @param optional Optional provider-neutral model settings.
   * @returns NeuralLink response events and the accumulated final response.
   */
  public async *query(
    model: string,
    input: AgentInput,
    optional: AgentQueryOptions = {},
  ): AgentQuery {
    const response = this.llm.call(model, input, optional);
    while (true) {
      const next = await response.next();
      if (next.done) return next.value as Response;
      yield next.value;
    }
  }
}
