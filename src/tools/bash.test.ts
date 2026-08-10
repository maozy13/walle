import { describe, expect, it, vi } from "vitest";
import { BashTool } from "./bash.js";

describe("BashTool", () => {
  it("parses quotes and escapes before invoking the configured executor", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    const bash = new BashTool({ cwd: "/workspace", executor });

    await expect(bash.fc({
      command: String.raw`grep "hello world" path\ with\ spaces`,
    })).resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(executor).toHaveBeenCalledWith(
      "grep",
      ["hello world", "path with spaces"],
      "/workspace",
    );
    expect(bash.schema.name).toBe("bash");
  });

  it.each([
    [{}, "non-empty string"],
    [{ command: 1 }, "non-empty string"],
    [{ command: " " }, "non-empty string"],
    [{ command: "node script.js" }, "not allowed"],
    [{ command: "" }, "non-empty string"],
  ])("rejects invalid command input %#", async (parameters, message) => {
    await expect(new BashTool({ executor: vi.fn() }).fc(parameters))
      .rejects.toThrow(message);
  });

  it.each([
    ["ls | wc", "Shell operator"],
    ["ls \\", "unfinished"],
    ["grep 'text", "unfinished"],
    ["find . -delete", "Mutating find"],
    ["find . -exec pwd", "Mutating find"],
    ["rg --pre command pattern", "Process-spawning"],
    ["rg --pre=command pattern", "Process-spawning"],
  ])("rejects unsafe command: %s", async (command, message) => {
    await expect(new BashTool({ executor: vi.fn() }).fc({ command }))
      .rejects.toThrow(message);
  });

  it("allows literal shell characters inside single quotes", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await new BashTool({ executor }).fc({ command: "grep '$value' package.json" });

    expect(executor).toHaveBeenCalledWith(
      "grep",
      ["$value", "package.json"],
      process.cwd(),
    );
  });

  it("executes a real read-only command with the default executor", async () => {
    const output = await new BashTool().fc({ command: "pwd" });

    expect(output.stdout.trim()).toBe(process.cwd());
    expect(output.stderr).toBe("");
  });

  it("reports failures from the default executor", async () => {
    await expect(new BashTool().fc({
      command: "ls definitely-not-a-real-walle-path",
    })).rejects.toThrow("Command failed:");
  });
});
