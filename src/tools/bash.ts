import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { FuncTool } from "../typings/tool.js";

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
  "sh",
  "stat",
  "tail",
  "touch",
  "wc",
  "bash",
  "node",
  "python",
  "python3",
]);

const scriptExtensions = new Map<string, ReadonlySet<string>>([
  ["sh", new Set([".sh"])],
  ["bash", new Set([".sh"])],
  ["python", new Set([".py"])],
  ["python3", new Set([".py"])],
  ["node", new Set([".js", ".mjs", ".cjs"])],
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

const bashParameters = z.object({
  command: z.string({
    error: 'bash requires a non-empty string argument named "command"',
  }).trim().min(1, {
    error: 'bash requires a non-empty string argument named "command"',
  }).describe("一条使用白名单可执行文件的命令"),
});

const bashDescription = [
  "在当前工作目录执行一条命令并返回 stdout 和 stderr。",
  "仅支持 cat、df、du、echo、file、find、grep、head、ls、mkdir、mv、pwd、rg、sed、stat、tail、touch、wc；其中 sed 可用于编辑文件，echo 可用于输出内容，touch 可用于创建文件或更新时间戳，mkdir 可用于创建目录，mv 可用于移动或重命名路径，其他命令仅允许只读用法。",
  "允许使用 sh、bash 执行 skills 目录内的 .sh 文件，使用 python、python3 执行 skills 目录内的 .py 文件，使用 node 执行 skills 目录内的 .js、.mjs、.cjs 文件；脚本路径必须是解释器的第一个参数，且不能逃逸 skills 目录。",
  "不支持 shell 运算符、重定向或命令替换；严禁权限命令、删除命令和磁盘管理命令。",
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
  const executor = options.executor ?? executeFile;
  const bash = async ({ command }: z.output<typeof bashParameters>): Promise<BashOutput> => {
    const [executable, ...args] = splitCommand(command);
    if (executable === undefined || !allowedCommands.has(executable)) {
      throw new Error(`Command "${executable ?? ""}" is not allowed`);
    }
    validateArguments(executable, args, cwd);
    return executor(executable, args, cwd);
  };
  return Object.assign(bash, {
    description: bashDescription,
    parameters: bashParameters,
  });
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
 * @param cwd Working directory used to constrain skill script paths.
 */
function validateArguments(executable: string, args: string[], cwd: string): void {
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
  const extensions = scriptExtensions.get(executable);
  if (extensions !== undefined) validateSkillScript(executable, args, cwd, extensions);
}

/**
 * Restricts an interpreter invocation to an existing script inside cwd/skills.
 * @param executable Approved script interpreter.
 * @param args Interpreter arguments beginning with the script path.
 * @param cwd Agent working directory containing the skills directory.
 * @param extensions File extensions accepted by the selected interpreter.
 */
function validateSkillScript(
  executable: string,
  args: string[],
  cwd: string,
  extensions: ReadonlySet<string>,
): void {
  const script = args[0];
  if (script === undefined || script.startsWith("-")) {
    throw new Error(`Command "${executable}" must execute a script under the skills directory`);
  }
  if (!extensions.has(extname(script).toLowerCase())) {
    throw new Error(`Command "${executable}" cannot execute script type "${extname(script)}"`);
  }

  const skillsDirectory = resolve(cwd, "skills");
  const scriptPath = resolve(cwd, script);
  if (!isPathInside(skillsDirectory, scriptPath)) {
    throw new Error(`Script "${script}" must be located under the skills directory`);
  }

  let realSkillsDirectory: string;
  let realScriptPath: string;
  try {
    realSkillsDirectory = realpathSync(skillsDirectory);
    realScriptPath = realpathSync(scriptPath);
  } catch {
    throw new Error(`Script "${script}" must reference an existing file under the skills directory`);
  }
  if (!isPathInside(realSkillsDirectory, realScriptPath)) {
    throw new Error(`Script "${script}" must not escape the skills directory through a symbolic link`);
  }
  if (!statSync(realScriptPath).isFile()) {
    throw new Error(`Script "${script}" must reference a file`);
  }
}

/**
 * Checks whether a candidate path is the root itself or one of its descendants.
 * @param rootPath Absolute root path.
 * @param candidatePath Absolute candidate path.
 * @returns Whether the candidate remains within the root.
 */
function isPathInside(rootPath: string, candidatePath: string): boolean {
  const child = relative(rootPath, candidatePath);
  return child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    && !isAbsolute(child);
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
