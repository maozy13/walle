import { describe, expect, it, vi } from "vitest";
import { Memory, Tools, type MemoryAdapter, type MemoryOperation } from "./index.js";
import {
  MEMORY_RETRIEVE_TOOL_NAME,
  MEMORY_UPDATE_TOOL_NAME,
} from "./memory.js";

/**
 * Attaches adapter metadata to an observable test operation.
 * @param name Adapter selector name.
 * @param description Model-facing operation description.
 * @param implementation Observable operation implementation.
 * @returns Memory operation carrying the requested metadata.
 */
function operation(
  name: string,
  description: string,
  implementation: (input: string) => unknown = vi.fn((input) => input),
): MemoryOperation<string> {
  Object.defineProperty(implementation, "name", { value: name });
  return Object.assign(implementation, { description });
}

/**
 * Creates a deterministic memory adapter for tests.
 * @param name Shared retrieval and update selector name.
 * @returns Adapter with observable operations.
 */
function adapter(name: string): MemoryAdapter {
  return {
    retrieve: operation(name, `${name} retrieve`, vi.fn((query) => ({ name, query }))),
    update: operation(name, `${name} update`, vi.fn((content) => ({ name, content }))),
  };
}

describe("Memory", () => {
  it("registers adapters and exposes the dynamic retrieval tool", async () => {
    const profile = adapter("profile");
    const terms = adapter("terms");
    const memory = new Memory([profile]).register(terms);
    const tools = new Tools([memory.retrieveTool()]);

    expect(tools.list()).toEqual([{
      type: "function",
      name: MEMORY_RETRIEVE_TOOL_NAME,
      description: [
        "召回记忆，可以从以下源选择合适的进行召回：",
        "- name: profile",
        "  description: profile retrieve",
        "- name: terms",
        "  description: terms retrieve",
      ].join("\n"),
      parameters: expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          name: expect.objectContaining({ enum: ["profile", "terms"] }),
          query: expect.objectContaining({ type: "string" }),
        }),
        required: ["name", "query"],
        additionalProperties: false,
      }),
    }]);
    await expect(tools.exec(
      MEMORY_RETRIEVE_TOOL_NAME,
      '{"name":"terms","query":"SLA"}',
    )).resolves.toEqual({ name: "terms", query: "SLA" });
    expect(terms.retrieve).toHaveBeenCalledWith("SLA");
  });

  it("routes model-generated content through the dynamic update tool", async () => {
    const terms = adapter("terms");
    const memory = new Memory([terms]);
    const tools = new Tools([memory.updateTool()]);

    expect(tools.list()[0]).toMatchObject({
      name: MEMORY_UPDATE_TOOL_NAME,
      description: expect.stringContaining("terms update"),
      parameters: {
        type: "object",
        properties: {
          name: expect.objectContaining({ enum: ["terms"] }),
          content: expect.objectContaining({ type: "string" }),
        },
        required: ["name", "content"],
        additionalProperties: false,
      },
    });
    await expect(tools.exec(
      MEMORY_UPDATE_TOOL_NAME,
      '{"name":"terms","content":"{\\"term\\":\\"SLA\\"}"}',
    )).resolves.toEqual({ name: "terms", content: '{"term":"SLA"}' });
    expect(terms.update).toHaveBeenCalledWith('{"term":"SLA"}');
    expect(memory.updateInstructions()).toContain(
      "- name: terms\n  description: terms update",
    );
  });

  it.each([
    ["empty retrieve name", { retrieve: operation(" ", "r"), update: operation(" ", "u") }, "must not be empty"],
    ["empty update name", { retrieve: operation("one", "r"), update: operation(" ", "u") }, "must not be empty"],
    ["mismatched names", { retrieve: operation("one", "r"), update: operation("two", "u") }, "must match"],
    ["duplicate name", adapter("duplicate"), "already registered"],
  ])("rejects invalid adapter registration: %s", (_kind, candidate, message) => {
    const memory = new Memory([adapter("duplicate")]);
    expect(() => memory.register(candidate)).toThrow(message);
  });

  it("rejects unknown retrieval and update adapters", async () => {
    const memory = new Memory();
    await expect(memory.retrieve("missing", "query"))
      .rejects.toThrow('Unknown memory adapter "missing"');
    await expect(memory.update("missing", "{}"))
      .rejects.toThrow('Unknown memory adapter "missing"');
  });

  it("creates unsatisfiable selectors and concise prompts for an empty registry", () => {
    const memory = new Memory();
    expect(new Tools([memory.retrieveTool()]).list()[0]?.parameters)
      .toMatchObject({ properties: { name: { not: {} } } });
    expect(memory.updateInstructions()).toContain("一旦完成任务立即退出。");
    expect(memory.retrieveTool().description).toBe(
      "召回记忆，可以从以下源选择合适的进行召回：",
    );
  });
});
