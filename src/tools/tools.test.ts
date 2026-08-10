import { describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../typings/tool.js";
import { Tools } from "./tools.js";

/**
 * Creates a minimal tool definition.
 * @param name Stable tool name.
 * @param fc Tool implementation.
 * @returns Tool definition.
 */
function definition(name: string, fc: ToolDef["fc"] = vi.fn()): ToolDef {
  return {
    schema: {
      type: "function",
      name,
      description: "test",
      parameters: { type: "object", properties: {} },
    },
    fc,
  };
}

describe("Tools", () => {
  it("registers, lists, and executes tools in order", async () => {
    const first = vi.fn().mockResolvedValue("ok");
    const tools = new Tools([definition("first", first)])
      .register(definition("second"));

    expect(tools.list().map(({ name }) => name)).toEqual(["first", "second"]);
    await expect(tools.exec("first", '{"value":1}')).resolves.toBe("ok");
    expect(first).toHaveBeenCalledWith({ value: 1 });
  });

  it.each([
    ["", "must not be empty"],
    ["duplicate", "already registered"],
  ])("rejects invalid registration: %s", (kind, message) => {
    const tools = new Tools([definition("duplicate")]);
    const candidate = kind === "" ? definition("  ") : definition("duplicate");

    expect(() => tools.register(candidate)).toThrow(message);
  });

  it("rejects unknown tools", async () => {
    await expect(new Tools().exec("missing", "{}"))
      .rejects.toThrow('Unknown tool "missing"');
  });

  it.each([
    ["invalid", "valid JSON"],
    ["null", "JSON object"],
    ["[]", "JSON object"],
    ["1", "JSON object"],
  ])("rejects invalid parameters: %s", async (parameters, message) => {
    await expect(new Tools([definition("tool")]).exec("tool", parameters))
      .rejects.toThrow(message);
  });
});
