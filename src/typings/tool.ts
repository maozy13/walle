import type { z } from "zod";

/**
 * Callable tool implementation carrying the metadata advertised to the model.
 * @template TParameters Zod schema used to validate model-selected arguments.
 * @template TResult Value returned by the tool implementation.
 */
export type FuncTool<
  TParameters extends z.ZodType = z.ZodType<any, any>,
  TResult = unknown,
> = ((
  /** Arguments parsed and validated by the tool's Zod schema. */
  parameters: z.output<TParameters>,
) => TResult | Promise<TResult>) & {
  /** Stable function name exposed to the model. */
  readonly name: string;
  /** Guidance describing when and how the model should use the tool. */
  readonly description: string;
  /** Zod schema converted to JSON Schema when tools are listed. */
  readonly parameters: TParameters;
};
