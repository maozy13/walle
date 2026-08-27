import { execFile } from "node:child_process";
import type { ToolArguments, ToolDef } from "../typings/tool.js";

const allowedCommands = new Set([
  "cat",
  "df",
  "du",
  "echo",
  "file",
  "find",
  "grep",
  "head",
  "ls",
  "mkdir",
  "mv",
  "pwd",
  "rg",
  "sed",
  "stat",
  "tail",
  "touch",
  "wc",
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
  /** Approved executable name. */
  executable: string,
  /** Validated process arguments. */
  args: string[],
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

/** Constrained command tool supporting reads, selected edits, and directory operations. */
export class BashTool implements ToolDef {
  public readonly schema = {
    type: "function" as const,
    name: "bash",
    description: [
      "在当前工作目录执行一条命令并返回 stdout 和 stderr。",
      "仅支持 cat、df、du、echo、file、find、grep、head、ls、mkdir、mv、pwd、rg、sed、stat、tail、touch、wc；其中 sed 可用于编辑文件，echo 可用于输出内容，touch 可用于创建文件或更新时间戳，mkdir 可用于创建目录，mv 可用于移动或重命名路径，其他命令仅允许只读用法。",
      "不支持 shell 运算符、重定向或命令替换；严禁权限命令、删除命令和磁盘管理命令。",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        command: {
          type: "string" as const,
          description: "一条使用白名单可执行文件的命令",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };

  public readonly fc: (parameters: ToolArguments) => Promise<BashOutput>;

  /**
   * Creates a constrained bash tool.
   * @param options Working directory and optional process runner.
   */
  public constructor(options: BashToolOptions = {}) {
    const cwd = options.cwd ?? process.cwd();
    const executor = options.executor ?? executeFile;
    this.fc = async (parameters: ToolArguments): Promise<BashOutput> => {
      const command = parameters.command;
      if (typeof command !== "string" || command.trim() === "") {
        throw new Error('bash requires a non-empty string argument named "command"');
      }
      const [executable, ...args] = splitCommand(command);
      if (executable === undefined || !allowedCommands.has(executable)) {
        throw new Error(`Command "${executable ?? ""}" is not allowed`);
      }
      validateArguments(executable, args);
      return executor(executable, args, cwd);
    };
  }
}

/**
 * Splits a conservative shell-like command line into process arguments.
 * @param command Model-selected command text.
 * @returns Executable followed by its arguments.
 */
function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === "\"") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token !== "") {
        tokens.push(token);
        token = "";
      }
    } else {
      if (";&|><`$(){}".includes(character)) {
        throw new Error(`Shell operator "${character}" is not allowed`);
      }
      token += character;
    }
  }

  if (escaped || quote !== undefined) {
    throw new Error("Command contains an unfinished escape or quote");
  }
  if (token !== "") tokens.push(token);
  return tokens;
}

/**
 * Rejects process-spawning modes exposed by otherwise read-only commands.
 * @param executable Approved executable name.
 * @param args Parsed process arguments.
 */
function validateArguments(executable: string, args: string[]): void {
  if (
    executable === "find"
    && args.some((argument) => [
      "-delete",
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
    ].includes(argument))
  ) {
    throw new Error("Mutating find actions are not allowed");
  }
  if (
    executable === "rg"
    && args.some((argument) => argument === "--pre" || argument.startsWith("--pre="))
  ) {
    throw new Error("Process-spawning rg options are not allowed");
  }
}

/**
 * Executes an approved command directly without invoking a shell.
 * @param executable Approved executable name.
 * @param args Validated process arguments.
 * @param cwd Working directory for the process.
 * @returns Captured stdout and stderr.
 */
function executeFile(
  executable: string,
  args: string[],
  cwd: string,
): Promise<BashOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
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
