import type { Tool } from "neuralink";

/** Parsed arguments supplied to a tool function. */
export type ToolArguments = Record<string, unknown>;

/** Function implementing one tool. */
export type ToolFunction = (
  /** Parsed model-selected arguments. */
  parameters: ToolArguments,
) => unknown | Promise<unknown>;

/** Tool metadata paired with its implementation. */
export interface ToolDef {
  /** NeuralLink tool metadata advertised to the model. */
  schema: Tool;
  /** Function invoked by the runtime. */
  fc: ToolFunction;
}
