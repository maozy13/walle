import type { Tool } from "neuralink";
import type { ToolArguments, ToolDef } from "../typings/tool.js";

/** Registry for tools available to an Agent. */
export class Tools {
  public readonly toolset = new Map<string, ToolDef>();

  /**
   * Creates a tool registry.
   * @param definitions Initial tools registered in declaration order.
   */
  public constructor(definitions: ToolDef[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  /**
   * Registers one tool definition.
   * @param definition Tool metadata and implementation.
   * @returns This registry for fluent configuration.
   */
  public register(definition: ToolDef): this {
    const name = definition.schema.name;
    if (name.trim() === "") throw new Error("Tool name must not be empty");
    if (this.toolset.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.toolset.set(name, definition);
    return this;
  }

  /**
   * Lists public metadata for all registered tools.
   * @returns Tool schemas in registration order.
   */
  public list(): Tool[] {
    return [...this.toolset.values()].map((definition) => definition.schema);
  }

  /**
   * Executes a registered tool with JSON-encoded parameters.
   * @param name Registered tool name.
   * @param parameters JSON object encoded as text.
   * @returns The tool result.
   */
  public async exec(name: string, parameters: string): Promise<unknown> {
    const definition = this.toolset.get(name);
    if (definition === undefined) throw new Error(`Unknown tool "${name}"`);
    return definition.fc(parseParameters(parameters));
  }
}

/**
 * Parses and validates model-selected tool parameters.
 * @param parameters JSON object encoded as text.
 * @returns Parsed tool arguments.
 */
function parseParameters(parameters: string): ToolArguments {
  let value: unknown;
  try {
    value = JSON.parse(parameters);
  } catch {
    throw new Error("Tool parameters must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool parameters must be a JSON object");
  }
  return value as ToolArguments;
}
