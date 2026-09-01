import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Agent } from "./agent.js";
import type { AgentEvent } from "./typings/agent.js";
import type {
  AgentCliConfig,
  AgentCliRuntime,
  ResolvedAgentCliConfig,
} from "./typings/cli.js";
import {
  Connector,
  ResponsesAPIConverter,
  type NormalizedParams,
  type Response,
  type ResponseEvent,
} from "neuralink";

const CONFIG_FILE = ".walle";
const INSTRUCTION_FILE = "WALLE.md";
const HELP = `Usage: walle [options]

Options:
  --base-url <url>       Model API URL
  --model <model>        Model identifier
  --api-key <key>        Model API key
  --instruction <text>   System instruction
  --session <id>         Restore a session
  --log                  Enable session logging
  --no-log               Disable configured logging
  --help                  Show this help
`;

const configSchema = z.object({
  baseUrl: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),
  instruction: z.string().optional(),
  session: z.string().min(1).optional(),
  log: z.boolean().optional(),
}).strict();

const resolvedConfigSchema = configSchema.extend({
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  log: z.boolean(),
});

/** Command-line values before file-based defaults are applied. */
interface ParsedArguments extends AgentCliConfig {
  /** Whether the caller requested usage text instead of a REPL. */
  help: boolean;
}

/** One JSON record stored in a session log. */
type SessionLogRecord =
  | { type: "request"; request: string }
  | { type: "response"; response: AgentEvent["response"] };

/** Appends request and response records for one Agent session. */
class SessionLogger {
  private readonly path: string;

  /**
   * Creates a logger and its parent directory.
   * @param sessionId Stable identifier of the Agent conversation being logged.
   * @param cwd Working directory containing the logs directory.
   */
  public constructor(sessionId: string, cwd: string) {
    const directory = resolve(cwd, "logs");
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, `${sessionId}.log`);
    appendFileSync(this.path, "", "utf8");
  }

  /**
   * Appends one JSON record to the session log.
   * @param record Request or model response to persist.
   */
  public append(record: SessionLogRecord): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

/** Responses API event types understood by NeuralLink's built-in converter. */
const SUPPORTED_PROVIDER_EVENTS = new Set([
  "response.created",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_text.delta",
  "response.function_call_arguments.delta",
]);

/** Provider source event accepted by the Responses API converter. */
type ResponsesApiSourceEvent = Parameters<ResponsesAPIConverter["fromEvent"]>[0];

/** Silently discards provider events that NeuralLink does not normalize. */
class CliResponsesAPIConverter extends ResponsesAPIConverter {
  /**
   * Converts normalized parameters using the built-in Responses API converter.
   * @param params Provider-neutral model parameters.
   * @returns Streaming Responses API request parameters.
   */
  public override toAPI(params: NormalizedParams): ReturnType<ResponsesAPIConverter["toAPI"]> {
    return super.toAPI(params);
  }

  /**
   * Filters unsupported source events before normalized conversion.
   * @param event Provider-specific streaming event.
   * @param response Response accumulated before this event.
   * @returns A normalized event, or undefined when the source event is ignored.
   */
  public override fromEvent(
    event: ResponsesApiSourceEvent,
    response?: Response,
  ): ResponseEvent | undefined {
    if (!isSupportedProviderEvent(event)) return undefined;
    return super.fromEvent(event, response);
  }
}

/** Streams reasoning, tool names, and answers in their CLI display formats. */
class ResponsePrinter {
  private answer = "";
  private answerStarted = false;
  private reasoning = "";
  private reasoningStartedAt = 0;
  private reasoningVisible = false;
  private readonly tools = new Set<string>();

  /**
   * Creates a response renderer.
   * @param output Destination stream for formatted model output.
   * @param now Clock used to measure reasoning time.
   */
  public constructor(
    private readonly output: NodeJS.WritableStream,
    private readonly now: () => number,
  ) {}

  /**
   * Writes the newly available content from one accumulated Agent event.
   * @param event Accumulated Agent response event.
   */
  public write(event: AgentEvent): void {
    if (event.type === "agent.response.created") {
      this.reset();
      return;
    }

    this.writeReasoning(reasoningText(event));
    this.writeTools(event);
    this.writeAnswer(answerText(event));
    if (event.type !== "agent.response.changed") this.finishReasoning();
  }

  /** Resets accumulated output state for a new model response. */
  private reset(): void {
    this.answer = "";
    this.answerStarted = false;
    this.reasoning = "";
    this.reasoningStartedAt = this.now();
    this.reasoningVisible = false;
    this.tools.clear();
  }

  /**
   * Streams newly accumulated reasoning text.
   * @param next Latest accumulated reasoning text.
   */
  private writeReasoning(next: string): void {
    const delta = appendedText(next, this.reasoning);
    if (delta === "") return;
    if (!this.reasoningVisible) {
      this.output.write("🤖 [思考中...]");
      this.reasoningVisible = true;
    }
    this.output.write(delta);
    this.reasoning = next;
  }

  /**
   * Prints newly selected tool names without their parameters.
   * @param event Accumulated Agent response event.
   */
  private writeTools(event: AgentEvent): void {
    for (const item of event.response.output) {
      if (item.type !== "function_call" || this.tools.has(item.call_id)) continue;
      this.finishReasoning();
      this.output.write(`🤖 [使用工具]${item.name}\n`);
      this.tools.add(item.call_id);
    }
  }

  /**
   * Streams newly accumulated answer or refusal text.
   * @param next Latest accumulated visible answer.
   */
  private writeAnswer(next: string): void {
    const delta = appendedText(next, this.answer);
    if (delta === "") return;
    this.finishReasoning();
    if (!this.answerStarted) {
      this.output.write("🤖 ");
      this.answerStarted = true;
    }
    this.output.write(delta);
    this.answer = next;
  }

  /** Replaces or follows streamed reasoning with its elapsed-time summary. */
  private finishReasoning(): void {
    if (!this.reasoningVisible) return;
    const seconds = Math.max(1, Math.ceil((this.now() - this.reasoningStartedAt) / 1000));
    const summary = `🤖 [已思考 ${seconds} 秒]\n`;
    if (isTerminalStream(this.output)) {
      eraseTerminalLines(this.output, this.reasoning.split("\n").length);
      this.output.write(summary);
    } else {
      this.output.write(`\n${summary}`);
    }
    this.reasoningVisible = false;
  }
}

/**
 * Parses supported command-line arguments without applying defaults.
 * @param args Arguments excluding the executable and script paths.
 * @returns Explicit CLI values and the help flag.
 */
function parseCliArguments(args: string[]): ParsedArguments {
  const { values } = parseArgs({
    args,
    options: {
      "base-url": { type: "string" },
      model: { type: "string" },
      "api-key": { type: "string" },
      instruction: { type: "string" },
      session: { type: "string" },
      log: { type: "boolean" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
    allowNegative: true,
  });
  return {
    ...(values["base-url"] === undefined ? {} : { baseUrl: values["base-url"] }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values["api-key"] === undefined ? {} : { apiKey: values["api-key"] }),
    ...(values.instruction === undefined ? {} : { instruction: values.instruction }),
    ...(values.session === undefined ? {} : { session: values.session }),
    ...(values.log === undefined ? {} : { log: values.log }),
    help: values.help ?? false,
  };
}

/**
 * Loads and validates the optional JSON configuration file.
 * @param cwd Working directory containing `.walle`.
 * @returns Validated persisted configuration, or an empty object when absent.
 */
function readConfig(cwd: string): AgentCliConfig {
  const path = resolve(cwd, CONFIG_FILE);
  const source = readOptionalFile(path);
  if (source === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid ${CONFIG_FILE}: malformed JSON`, { cause: error });
  }
  const result = configSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${CONFIG_FILE}: ${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Reads a UTF-8 file while treating only absence as an optional value.
 * @param path Absolute file path to read.
 * @returns File contents, or undefined when the file does not exist.
 */
function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Checks whether a thrown value exposes a Node.js error code.
 * @param error Unknown thrown value.
 * @returns Whether the value is a Node.js system error.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Resolves CLI configuration using documented precedence rules.
 * @param args Arguments excluding executable and script paths.
 * @param cwd Working directory containing CLI configuration files.
 * @returns Fully validated configuration, or undefined when help was requested.
 */
export function resolveCliConfig(
  args: string[],
  cwd: string = process.cwd(),
): ResolvedAgentCliConfig | undefined {
  const cli = parseCliArguments(args);
  if (cli.help) return undefined;
  const file = readConfig(cwd);
  const defaultInstruction = readOptionalFile(resolve(cwd, INSTRUCTION_FILE));
  const merged = {
    ...(defaultInstruction === undefined ? {} : { instruction: defaultInstruction }),
    ...file,
    ...withoutHelp(cli),
    log: cli.log ?? file.log ?? false,
  };
  const result = resolvedConfigSchema.safeParse(merged);
  if (!result.success) throw new Error(`Invalid CLI configuration: ${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Removes the parser-only help flag from explicit CLI configuration.
 * @param parsed Parsed CLI arguments.
 * @returns Only values that participate in configuration merging.
 */
function withoutHelp(parsed: ParsedArguments): AgentCliConfig {
  const { help: _help, ...config } = parsed;
  return config;
}

/**
 * Checks whether a provider event can be normalized without diagnostic output.
 * @param event Responses API source event to inspect.
 * @returns Whether the CLI should delegate the event to NeuralLink.
 */
function isSupportedProviderEvent(event: ResponsesApiSourceEvent): boolean {
  if (event === "[DONE]") return true;
  if (!SUPPORTED_PROVIDER_EVENTS.has(event.type)) return false;
  if (event.type !== "response.output_item.added") return true;
  const item = event.item;
  return isRecord(item)
    && (item.type === "message" || item.type === "reasoning" || item.type === "function_call");
}

/**
 * Checks whether an unknown value is a non-null object.
 * @param value Unknown value to inspect.
 * @returns Whether named properties can be read safely.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extracts streamed reasoning summaries, falling back to reasoning content.
 * @param event Agent response event to render.
 * @returns Concatenated reasoning text.
 */
function reasoningText(event: AgentEvent): string {
  return event.response.output
    .filter((item) => item.type === "reasoning")
    .map((item) => item.summary.text === "" ? item.content.text : item.summary.text)
    .join("\n");
}

/**
 * Extracts user-visible answer or refusal text from an accumulated event.
 * @param event Agent response event to render.
 * @returns Concatenated visible answer text.
 */
function answerText(event: AgentEvent): string {
  return event.response.output
    .filter((item) => item.type === "message")
    .map((item) => item.content.type === "output_text"
      ? item.content.text
      : item.content.refusal)
    .join("\n");
}

/**
 * Calculates the newly appended portion of accumulated model text.
 * @param next Latest accumulated text.
 * @param previous Previously printed accumulated text.
 * @returns New suffix, an empty string, or a replacement on a new line.
 */
function appendedText(next: string, previous: string): string {
  if (next === previous) return "";
  return next.startsWith(previous) ? next.slice(previous.length) : `\n${next}`;
}

/**
 * Checks whether a writable stream represents an interactive terminal.
 * @param output Writable output stream.
 * @returns Whether terminal cursor controls may be emitted.
 */
function isTerminalStream(output: NodeJS.WritableStream): boolean {
  return "isTTY" in output && output.isTTY === true;
}

/**
 * Clears streamed reasoning lines and returns the cursor to their first line.
 * @param output Interactive terminal stream.
 * @param lines Number of rendered logical lines to erase.
 */
function eraseTerminalLines(output: NodeJS.WritableStream, lines: number): void {
  output.write("\r\u001B[2K");
  for (let index = 1; index < lines; index += 1) {
    output.write("\u001B[1A\r\u001B[2K");
  }
}

/**
 * Executes one interactive request and streams its model response.
 * @param agent Persistent Agent shared across REPL turns.
 * @param model Provider model identifier.
 * @param input Trimmed user request.
 * @param output Destination stream for model output.
 * @param logger Optional session logger.
 * @param now Clock used to measure reasoning duration.
 * @returns Completion after the Agentic loop terminates.
 */
async function runTurn(
  agent: Agent,
  model: string,
  input: string,
  output: NodeJS.WritableStream,
  logger?: SessionLogger,
  now: () => number = Date.now,
): Promise<void> {
  logger?.append({ type: "request", request: input });
  const printer = new ResponsePrinter(output, now);
  for await (const event of agent.query(model, input)) {
    printer.write(event);
    if (event.type !== "agent.response.changed" && event.type !== "agent.response.created") {
      logger?.append({ type: "response", response: event.response });
    }
  }
  output.write("\n");
}

/**
 * Runs the WallE interactive Agent CLI.
 * @param args Arguments excluding executable and script paths.
 * @param runtime Injectable working directory, streams, and fetch implementation.
 * @returns Completion after input closes or the user exits.
 */
export async function runCli(
  args: string[] = process.argv.slice(2),
  runtime: AgentCliRuntime = {
    cwd: process.cwd(),
    input: process.stdin,
    output: process.stdout,
    fetch,
  },
): Promise<void> {
  const config = resolveCliConfig(args, runtime.cwd);
  if (config === undefined) {
    runtime.output.write(HELP);
    return;
  }
  const llm = new Connector(
    config.baseUrl,
    config.apiKey,
    new CliResponsesAPIConverter(),
    { fetch: runtime.fetch },
  );
  const agent = new Agent({
    llm,
    cwd: runtime.cwd,
    ...(config.instruction === undefined ? {} : { instructions: config.instruction }),
    ...(config.session === undefined ? {} : { sessionId: config.session }),
  });
  const logger = config.log
    ? new SessionLogger(agent.conversation.id, runtime.cwd)
    : undefined;
  const readline = createInterface({
    input: runtime.input,
    output: runtime.output,
    terminal: "isTTY" in runtime.input && runtime.input.isTTY === true,
  });
  let closed = false;
  readline.once("close", () => {
    closed = true;
  });
  readline.setPrompt("You> ");
  readline.prompt();
  try {
    for await (const line of readline) {
      const input = line.trim();
      if (input === "/exit" || input === "/quit") break;
      if (input !== "") {
        await runTurn(agent, config.model, input, runtime.output, logger, runtime.now);
      }
      if (!closed) readline.prompt();
    }
  } finally {
    readline.close();
  }
}
