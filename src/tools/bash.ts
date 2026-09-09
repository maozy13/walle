import { execFile } from "node:child_process";
import { basename } from "node:path";
import { z } from "zod";
import type { FuncTool } from "../typings/tool.js";

const forbiddenCommands = new Set([
  "chmod",
  "chown",
  "fdisk",
  "mount",
  "rm",
  "rmdir",
  "su",
  "sudo",
  "unmount",
]);

/** Captured output from the built-in bash tool. */
export interface BashOutput {
  /** Standard output emitted by the command. */
  stdout: string;
  /** Standard error emitted by the command. */
  stderr: string;
}

/** Process runner used by the built-in bash tool. */
export type BashExecutor = (
  /** Bash source to execute. */
  command: string,
  /** Working directory for the process. */
  cwd: string,
) => Promise<BashOutput>;

/** Configuration for the built-in bash tool. */
export interface BashToolOptions {
  /** Working directory used for command execution. */
  cwd?: string;
  /** Optional process runner, primarily for deterministic tests. */
  executor?: BashExecutor;
}

const bashParameters = z.object({
  command: z.string({
    error: 'bash requires a non-empty string argument named "command"',
  }).trim().min(1, {
    error: 'bash requires a non-empty string argument named "command"',
  }).describe("一条 bash 命令"),
});

const bashDescription = [
  "在当前工作目录执行一条 bash 命令，返回 stdout 和 stderr。",
  "出于安全考虑：",
  "严禁执行任何权限命令：su、sudo、chmod、chown 等；",
  "严禁执行任何删除命令：rm、rmdir 等；",
  "严禁执行任何磁盘操作命令：mount、unmount、fdisk 等，但可以执行 du、df 等查看操作。",
].join(" ");

/**
 * Creates the constrained bash function tool.
 * @param options Working directory and optional process runner.
 * @returns A callable bash tool with Zod-backed model metadata.
 */
export function createBashTool(
  options: BashToolOptions = {},
): FuncTool<typeof bashParameters, BashOutput> {
  const cwd = options.cwd ?? process.cwd();
  const executor = options.executor ?? executeBash;
  const bash = async ({ command }: z.output<typeof bashParameters>): Promise<BashOutput> => {
    validateCommand(command);
    return executor(command, cwd);
  };
  return Object.assign(bash, {
    description: bashDescription,
    parameters: bashParameters,
  });
}

/**
 * Rejects commands explicitly prohibited by the tool contract.
 * @param command Bash source selected by the model.
 */
function validateCommand(command: string): void {
  for (const word of shellWords(command)) {
    const executable = basename(word);
    if (forbiddenCommands.has(executable)) {
      throw new Error(`Command "${executable}" is not allowed`);
    }
  }
}

/**
 * Extracts shell words while preserving quoted text as one value.
 * @param command Bash source to inspect.
 * @returns Decoded words that may identify invoked executables.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  const push = (): void => {
    if (word !== "") words.push(word);
    word = "";
  };

  for (const character of command) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === "'" || character === "\"") {
      quote = character;
    } else if (/\s/.test(character) || ";&|><`(){}".includes(character)) {
      push();
    } else {
      word += character;
    }
  }

  if (escaped || quote !== undefined) {
    throw new Error("Command contains an unfinished escape or quote");
  }
  push();
  return words;
}

/**
 * Executes command source through Bash.
 * @param command Bash source to execute.
 * @param cwd Working directory for the process.
 * @returns Captured stdout and stderr.
 */
function executeBash(command: string, cwd: string): Promise<BashOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/bash",
      ["-c", command],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1_000_000,
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Command failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
