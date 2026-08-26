import type { ToolDef } from "./typings/tool.js";
import type {
  MemoryAdapter,
  MemoryContext,
  MemoryRetrieveArguments,
} from "./typings/memory.js";

/** Tool name reserved for model-directed memory retrieval. */
export const MEMORY_RETRIEVE_TOOL_NAME = "memory.retrieve";

/** Registry and dispatcher for Agent memory systems. */
export class Memory {
  public readonly adapters = new Map<string, MemoryAdapter>();

  /**
   * Creates a memory registry from an optional ordered adapter list.
   * @param adapters Memory adapters to register.
   */
  public constructor(adapters: MemoryAdapter[] = []) {
    for (const adapter of adapters) this.registry(adapter);
  }

  /**
   * Registers one memory adapter.
   * @param adapter Adapter metadata and implementation.
   * @returns This memory registry for fluent configuration.
   */
  public registry(adapter: MemoryAdapter): this {
    const name = adapter.name;
    if (name.trim() === "") throw new Error("Memory adapter name must not be empty");
    if (this.adapters.has(name)) {
      throw new Error(`Memory adapter "${name}" is already registered`);
    }
    this.adapters.set(name, adapter);
    return this;
  }

  /**
   * Retrieves content from a named memory adapter.
   * @param name Registered adapter name.
   * @param query Search expression selected by the model.
   * @returns Adapter-specific retrieved content.
   */
  public async retrieve(name: string, query: string): Promise<unknown> {
    const adapter = this.adapters.get(name);
    if (adapter === undefined) throw new Error(`Unknown memory adapter "${name}"`);
    return adapter.retrieve(query);
  }

  /**
   * Builds the dynamic tool definition used to inject recalled memory.
   * @returns A tool definition reflecting all currently registered adapters.
   */
  public inject(): ToolDef {
    const adapters = [...this.adapters.values()];
    const names = adapters.map(({ name }) => name);
    const choices = adapters
      .map(({ name, description }) => `- name: ${name}\n  description: ${description}`)
      .join("\n");
    return {
      schema: {
        type: "function",
        name: MEMORY_RETRIEVE_TOOL_NAME,
        description: `从不同的源进行记忆的召回，以下是可选的源的名称和描述：\n${choices}`,
        parameters: {
          type: "object",
          properties: {
            name: {
              enum: names,
              name: "MemoryAdapter 的名称",
            },
            query: {
              type: "string",
              name: "要召回的查询条件",
            },
          },
        },
      },
      fc: (parameters) => {
        const { name, query } = parameters as unknown as MemoryRetrieveArguments;
        if (typeof name !== "string" || typeof query !== "string") {
          throw new Error("Memory retrieval requires string name and query parameters");
        }
        return this.retrieve(name, query);
      },
    };
  }

  /**
   * Pushes a completed task context to every registered adapter in parallel.
   * @param context Task-local conversation context and metadata.
   * @returns Completion of all adapter updates.
   */
  public async update(context: MemoryContext): Promise<void> {
    await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.update(context)),
    );
  }
}
