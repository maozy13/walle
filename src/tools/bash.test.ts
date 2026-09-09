import { describe, expect, it, vi } from "vitest";
import { createBashTool } from "./bash.js";

describe("createBashTool", () => {
  it("passes a general bash command to the configured executor", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    const bash = createBashTool({ cwd: "/workspace", executor });

    await expect(bash({ command: "git status --short | head -1" }))
      .resolves.toEqual({ stdout: "ok", stderr: "" });
    expect(executor).toHaveBeenCalledWith("git status --short | head -1", "/workspace");
    expect(bash.name).toBe("bash");
    expect(bash.description).toContain("sudo");
    expect(bash.parameters.toJSONSchema()).toBeDefined();
  });

  it.each([
    [{}, "non-empty string"],
    [{ command: 1 }, "non-empty string"],
    [{ command: " " }, "non-empty string"],
    [{ command: "" }, "non-empty string"],
  ])("rejects invalid command input %#", (parameters, message) => {
    const bash = createBashTool({ executor: vi.fn() });

    expect(() => bash.parameters.parse(parameters)).toThrow(message);
  });

  it.each([
    ["sudo apt update", "sudo"],
    ["/usr/bin/chmod 777 file", "chmod"],
    ["echo ok && rm file", "rm"],
    ["rmdir empty", "rmdir"],
    ["mount /dev/disk /mnt", "mount"],
    ["unmount /mnt", "unmount"],
    ["fdisk /dev/disk", "fdisk"],
    ["su root", "su"],
    ["chown user file", "chown"],
  ])("rejects forbidden command: %s", async (command, executable) => {
    await expect(createBashTool({ executor: vi.fn() })({ command }))
      .rejects.toThrow(`Command "${executable}" is not allowed`);
  });

  it.each(["echo 'unfinished", "echo unfinished\\"])(
    "rejects malformed command: %s",
    async (command) => {
      await expect(createBashTool({ executor: vi.fn() })({ command }))
        .rejects.toThrow("unfinished");
    },
  );

  it("allows the documented read-only disk commands", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const bash = createBashTool({ executor });

    await bash({ command: "du -sh .; df -h" });

    expect(executor).toHaveBeenCalledWith("du -sh .; df -h", process.cwd());
  });

  it("accepts escaped characters in command words", async () => {
    const executor = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

    await createBashTool({ executor })({ command: String.raw`printf escaped\ value` });

    expect(executor).toHaveBeenCalledWith(String.raw`printf escaped\ value`, process.cwd());
  });

  it("executes shell operators with the default executor", async () => {
    const output = await createBashTool()({ command: "printf first | tr a-z A-Z" });

    expect(output).toEqual({ stdout: "FIRST", stderr: "" });
  });

  it("reports failures from the default executor", async () => {
    await expect(createBashTool()({ command: "ls definitely-not-a-real-walle-path" }))
      .rejects.toThrow("Command failed:");
  });
});
