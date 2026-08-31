import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "./bash.js";

describe("createBashTool", () => {
  it("parses quotes and escapes before invoking the configured executor", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    const bash = createBashTool({ cwd: "/workspace", executor });

    await expect(bash({
      command: String.raw`grep "hello world" path\ with\ spaces`,
    })).resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(executor).toHaveBeenCalledWith(
      "grep",
      ["hello world", "path with spaces"],
      "/workspace",
    );
    expect(bash.name).toBe("bash");
  });

  it.each([
    [{}, "non-empty string"],
    [{ command: 1 }, "non-empty string"],
    [{ command: " " }, "non-empty string"],
    [{ command: "node script.js" }, "not allowed"],
    [{ command: "" }, "non-empty string"],
  ])("rejects invalid command input %#", async (parameters, message) => {
    const bash = createBashTool({ executor: vi.fn() });
    if (parameters.command === "node script.js") {
      await expect(bash(bash.parameters.parse(parameters))).rejects.toThrow(message);
    } else {
      expect(() => bash.parameters.parse(parameters)).toThrow(message);
    }
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
    await expect(createBashTool({ executor: vi.fn() })({ command }))
      .rejects.toThrow(message);
  });

  it("allows literal shell characters inside single quotes", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await createBashTool({ executor })({ command: "grep '$value' package.json" });

    expect(executor).toHaveBeenCalledWith(
      "grep",
      ["$value", "package.json"],
      process.cwd(),
    );
  });

  it.each([
    ["echo generated content", "echo", ["generated", "content"]],
    ["sed -i s/old/new/g file.txt", "sed", ["-i", "s/old/new/g", "file.txt"]],
    ["touch created.txt", "touch", ["created.txt"]],
  ])("allows selected content command: %s", async (command, executable, args) => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const bash = createBashTool({ cwd: "/workspace", executor });

    await bash({ command });

    expect(executor).toHaveBeenCalledWith(executable, args, "/workspace");
    expect(bash.description).toContain(executable);
  });

  it.each([
    ["mkdir -p archive", "mkdir", ["-p", "archive"]],
    ["mv draft.txt archive/final.txt", "mv", ["draft.txt", "archive/final.txt"]],
  ])("allows selected directory command: %s", async (command, executable, args) => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const bash = createBashTool({ cwd: "/workspace", executor });

    await bash({ command });

    expect(executor).toHaveBeenCalledWith(executable, args, "/workspace");
    expect(bash.description).toContain(executable);
  });

  it("executes a real read-only command with the default executor", async () => {
    const output = await createBashTool()({ command: "pwd" });

    expect(output.stdout.trim()).toBe(process.cwd());
    expect(output.stderr).toBe("");
  });

  it("reports failures from the default executor", async () => {
    await expect(createBashTool()({
      command: "ls definitely-not-a-real-walle-path",
    })).rejects.toThrow("Command failed:");
  });
});
