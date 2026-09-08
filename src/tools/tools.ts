import type { Tool } from "@maozy13/neuralink";
import { z } from "zod";
import type { FuncTool } from "../typings/tool.js";

type RegisteredTool = FuncTool<z.ZodType<any, any>>;

/** Registry for tools available to an Agent. */
export class Tools {
  public readonly tools = new Map<string, RegisteredTool>();

  /**
   * Creates a tool registry.
   * @param tools Initial tools registered in declaration order.
   */
  public constructor(tools: RegisteredTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  /**
   * Registers one tool definition.
   * @param tool Callable tool and its model-facing metadata.
   * @returns This registry for fluent configuration.
   */
  public register(tool: RegisteredTool): this {
    const name = tool.name;
    if (name.trim() === "") throw new Error("Tool name must not be empty");
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.tools.set(name, tool);
    return this;
  }

  /**
   * Lists public metadata for all registered tools.
   * @returns Tool schemas in registration order.
   */
  public list(): Tool[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.parameters),
    }));
  }

  /**
   * Executes a registered tool with JSON-encoded parameters.
   * @param name Registered tool name.
   * @param parameters JSON object encoded as text.
   * @returns The tool result.
   */
  public async exec(name: string, parameters: string): Promise<unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`Unknown tool "${name}"`);
    return tool(tool.parameters.parse(parseParameters(parameters)));
  }
}

/**
 * Parses and validates model-selected tool parameters.
 * @param parameters JSON object encoded as text.
 * @returns Parsed tool arguments.
 */
function parseParameters(parameters: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(parameters);
  } catch {
    throw new Error("Tool parameters must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool parameters must be a JSON object");
  }
  return value;
}
