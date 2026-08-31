import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FuncTool } from "../typings/tool.js";
import { Tools } from "./tools.js";

/**
 * Creates a minimal function tool.
 * @param name Stable tool name.
 * @param fc Tool implementation.
 * @returns Callable function tool.
 */
function definition(
  name: string,
  fc: (parameters: Record<string, unknown>) => unknown = vi.fn(),
): FuncTool {
  const tool = (parameters: Record<string, unknown>): unknown => fc(parameters);
  Object.defineProperty(tool, "name", { value: name });
  return Object.assign(tool, {
    description: "test",
    parameters: z.object({}).passthrough(),
  });
}

describe("Tools", () => {
  it("registers, lists, and executes tools in order", async () => {
    const first = vi.fn().mockResolvedValue("ok");
    const tools = new Tools([definition("first", first)])
      .register(definition("second"));

    expect(tools.list().map(({ name }) => name)).toEqual(["first", "second"]);
    expect(tools.list()[0]?.parameters).toMatchObject({
      type: "object",
      additionalProperties: {},
    });
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

  it("validates parameters with the registered Zod schema", async () => {
    function validated(parameters: { value: number }): number {
      return parameters.value;
    }
    Object.assign(validated, {
      description: "validated",
      parameters: z.object({ value: z.number() }),
    });

    await expect(new Tools([validated]).exec("validated", '{"value":"1"}'))
      .rejects.toThrow();
  });
});
