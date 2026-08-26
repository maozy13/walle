import { describe, expect, it, vi } from "vitest";
import {
  Memory,
  type MemoryAdapter,
  type MemoryContext,
} from "./index.js";
import { MEMORY_RETRIEVE_TOOL_NAME } from "./memory.js";

/**
 * Creates a deterministic memory adapter for tests.
 * @param name Unique adapter name.
 * @param description Adapter selection guidance.
 * @returns Mock adapter with observable methods.
 */
function adapter(name: string, description = `${name} description`): MemoryAdapter {
  return {
    name,
    description,
    retrieve: vi.fn((query: string) => ({ name, query })),
    update: vi.fn(),
  };
}

describe("Memory", () => {
  it("registers adapters and exposes a dynamic retrieval tool", async () => {
    const profile = adapter("profile", "用户画像");
    const memory = new Memory([profile]);
    const terms = adapter("terms", "业务术语");
    memory.registry(terms);

    const definition = memory.inject();

    expect(definition.schema).toEqual({
      type: "function",
      name: MEMORY_RETRIEVE_TOOL_NAME,
      description: [
        "从不同的源进行记忆的召回，以下是可选的源的名称和描述：",
        "- name: profile",
        "  description: 用户画像",
        "- name: terms",
        "  description: 业务术语",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          name: {
            enum: ["profile", "terms"],
            name: "MemoryAdapter 的名称",
          },
          query: {
            type: "string",
            name: "要召回的查询条件",
          },
        },
      },
    });
    await expect(definition.fc({ name: "terms", query: "SLA" }))
      .resolves.toEqual({ name: "terms", query: "SLA" });
    expect(terms.retrieve).toHaveBeenCalledWith("SLA");
  });

  it("updates every adapter in parallel", async () => {
    const first = adapter("first");
    const second = adapter("second");
    const memory = new Memory([first, second]);
    const context: MemoryContext = {
      conversation: { id: "conversation", items: [] },
      metadata: { model: "model", startedAt: 1, completedAt: 2 },
    };

    await memory.update(context);

    expect(first.update).toHaveBeenCalledWith(context);
    expect(second.update).toHaveBeenCalledWith(context);
  });

  it.each([
    ["empty", "must not be empty"],
    ["duplicate", "already registered"],
  ])("rejects invalid adapter registration: %s", (kind, message) => {
    const memory = new Memory([adapter("duplicate")]);
    const candidate = kind === "empty" ? adapter("  ") : adapter("duplicate");

    expect(() => memory.registry(candidate)).toThrow(message);
  });

  it("rejects unknown adapters", async () => {
    await expect(new Memory().retrieve("missing", "query"))
      .rejects.toThrow('Unknown memory adapter "missing"');
  });

  it.each([
    [{ name: 1, query: "query" }],
    [{ name: "profile", query: 1 }],
  ])("validates retrieval tool arguments %#", async (parameters) => {
    const definition = new Memory([adapter("profile")]).inject();

    expect(() => definition.fc(parameters))
      .toThrow("requires string name and query");
  });
});
