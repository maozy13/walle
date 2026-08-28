import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  Agent,
  BashTool,
  Connector,
  ResponsesAPIConverter,
  Tools,
  type AgentEvent,
  type ConversationItem,
} from "walle";

const baseUrl = "https://ark.cn-beijing.volces.com/api/v3/responses";
const model = "doubao-seed-evolving";
const ANSI_RESET = "\u001B[0m";
const ANSI_BOLD = "\u001B[1m";
const ANSI_CYAN = "\u001B[36m";
const ANSI_GREEN = "\u001B[32m";
const ANSI_MAGENTA = "\u001B[35m";
const ANSI_RED = "\u001B[31m";

/** One tool execution currently displayed in the terminal. */
interface ToolExecution {
  /** Registered tool name being executed. */
  name: string;
}

/** Agent initialization options selected from the command line. */
interface AgentCliOptions {
  /** Optional system instructions loaded from the selected file. */
  instructions?: string;
  /** Whether requests and completed response snapshots should be logged. */
  log: boolean;
  /** Optional persisted session identifier to load. */
  sessionId?: string;
}

/** JSONL logger for one Agent session. */
class SessionLogger {
  private readonly path: string;

  /**
   * Creates a logger under the current working directory.
   * @param sessionId Stable identifier of the Agent conversation being logged.
  * @param cwd Working directory containing the logs directory.
  */
  public constructor(sessionId: string, cwd: string = process.cwd()) {
    const directory = resolve(cwd, "logs");
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, `${sessionId}.jsonl`);
  }

  /**
   * Records one user request before it is sent through the Agent loop.
   * @param request User request supplied to Agent.query().
   */
  public request(request: string): void {
    this.append({ type: "request", request });
  }

  /**
   * Records the final accumulated response for one streamed model call.
   * @param response Completed, failed, or incomplete response snapshot.
   */
  public response(response: AgentEvent["response"]): void {
    this.append({ type: "response", response });
  }

  /**
   * Appends one JSON value as a single JSONL record.
   * @param record Serializable log record to append.
   */
  private append(record: object): void {
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

/** A user-visible item that can be restored in the terminal transcript. */
type VisibleConversationItem = Extract<
  ConversationItem,
  { type: "text" | "image" | "file" }
>;

/** Live, replaceable terminal panel for one parallel batch of tool calls. */
class ToolPanel {
  private readonly active: ToolExecution[] = [];
  private executionCount = 0;
  private savedCursor = false;
  private collapseVersion = 0;

  /**
   * Adds a tool to the active execution display.
   * @param name Registered tool name.
   * @returns Execution token used to mark this tool complete.
   */
  public begin(name: string): ToolExecution {
    const execution = { name };
    this.active.push(execution);
    this.executionCount += 1;
    this.collapseVersion += 1;
    if (process.stdout.isTTY) {
      this.render();
    } else {
      process.stdout.write(`正在执行工具 ${name}\n`);
    }
    return execution;
  }

  /**
   * Removes one completed tool and schedules batch collapse.
   * @param execution Execution token returned by begin().
   */
  public complete(execution: ToolExecution): void {
    const index = this.active.indexOf(execution);
    if (index >= 0) this.active.splice(index, 1);
    this.render();
    const version = ++this.collapseVersion;
    queueMicrotask(() => {
      if (this.active.length === 0 && version === this.collapseVersion) this.collapse();
    });
  }

  /** Replaces the live tool details with a compact execution count. */
  private collapse(): void {
    const summary = `${paint("✓", ANSI_GREEN)} 已执行 ${this.executionCount} 次工具`;
    if (process.stdout.isTTY && this.savedCursor) {
      process.stdout.write(`\u001B[u\u001B[J${summary}\n`);
    } else {
      process.stdout.write(`${summary}\n`);
    }
    this.executionCount = 0;
    this.savedCursor = false;
  }

  /** Refreshes the replaceable tool panel in an interactive terminal. */
  private render(): void {
    if (!process.stdout.isTTY) return;
    if (!this.savedCursor) {
      process.stdout.write("\u001B[s");
      this.savedCursor = true;
    }
    process.stdout.write(`\u001B[u\u001B[J${this.content()}`);
  }

  /**
   * Formats the complete current tool batch.
   * @returns Human-readable tool panel text ending in a newline.
   */
  private content(): string {
    return `${this.active.map(({ name }) => `正在执行工具 ${name}`).join("\n")}\n`;
  }
}

/** Tool registry that updates a replaceable terminal panel around executions. */
class DisplayTools extends Tools {
  /**
   * Creates a tool registry connected to a terminal panel.
   * @param panel Tool panel receiving execution state changes.
   * @param definitions Initial tool definitions.
   */
  public constructor(
    private readonly panel: ToolPanel,
    definitions: ConstructorParameters<typeof Tools>[0],
  ) {
    super(definitions);
  }

  /**
   * Executes a registered tool while reporting its active state to the panel.
   * @param name Registered tool name selected by the model.
   * @param parameters JSON-encoded tool arguments selected by the model.
   * @returns The registered tool's response.
   */
  public override async exec(name: string, parameters: string): Promise<unknown> {
    const execution = this.panel.begin(name);
    try {
      return await super.exec(name, parameters);
    } finally {
      this.panel.complete(execution);
    }
  }
}

/** Incremental renderer for Agent reasoning and answer snapshots. */
class AgentPrinter {
  private thinking = "";
  private answer = "";
  private section: "thinking" | "answer" | undefined;

  /**
   * Streams newly available reasoning and answer content.
   * @param event WallE response event emitted during one Agent turn.
   */
  public write(event: AgentEvent): void {
    if (event.type === "agent.response.created") {
      this.thinking = "";
      this.answer = "";
      this.section = undefined;
      return;
    }

    const reasoning = event.response.output.filter((item) => item.type === "reasoning");
    const summaries = reasoning
      .map((item) => item.summary.text)
      .filter((text) => text.trim() !== "")
      .join("\n");
    const content = reasoning
      .map((item) => item.content.text)
      .filter((text) => text.trim() !== "")
      .join("\n");
    const thinking = summaries === "" ? content : summaries;
    const answer = event.response.output
      .filter((item) => item.type === "message")
      .map((item) => item.content.type === "output_text"
        ? item.content.text
        : item.content.refusal)
      .join("\n");

    this.thinking = this.writeDelta("thinking", "💭  思考", thinking, this.thinking);
    this.answer = this.writeDelta("answer", "🤖  WallE", answer, this.answer);

    if (event.type !== "agent.response.changed") {
      this.finishSection();
      if (event.type !== "agent.response.completed") {
        process.stdout.write(`${paint("⚠", ANSI_RED)} Agent 状态：${event.response.status}\n`);
      }
    }
  }

  /** Ensures the final streamed section ends with a newline. */
  public finishTurn(): void {
    this.finishSection();
  }

  /**
   * Writes only the suffix added to one accumulated text snapshot.
   * @param section Output section receiving the text.
   * @param title User-visible section title.
   * @param next Latest accumulated text.
   * @param previous Previously printed accumulated text.
   * @returns Latest accumulated text for the next event.
   */
  private writeDelta(
    section: "thinking" | "answer",
    title: string,
    next: string,
    previous: string,
  ): string {
    if (next === previous) return previous;
    this.startSection(section, title);
    process.stdout.write(next.startsWith(previous) ? next.slice(previous.length) : `\n${next}`);
    return next;
  }

  /**
   * Starts a labeled section, separating it from earlier streamed content.
   * @param section Output section being started.
   * @param title User-visible section title.
   */
  private startSection(section: "thinking" | "answer", title: string): void {
    if (this.section === section) return;
    this.finishSection();
    const color = section === "thinking" ? ANSI_MAGENTA : ANSI_GREEN;
    process.stdout.write(`${paint(title, `${ANSI_BOLD}${color}`)}\n`);
    this.section = section;
  }

  /** Ends the current streamed section when one is active. */
  private finishSection(): void {
    if (this.section === undefined) return;
    process.stdout.write("\n\n");
    this.section = undefined;
  }
}

/**
 * Applies terminal color only for interactive output.
 * @param text Text to decorate.
 * @param ansi ANSI style prefix.
 * @returns Styled or plain text depending on terminal capability.
 */
function paint(text: string, ansi: string): string {
  return process.stdout.isTTY ? `${ansi}${text}${ANSI_RESET}` : text;
}

/**
 * Parses command-line options used to initialize the Agent.
 * @param args Command-line arguments excluding the executable and script paths.
 * @returns Agent initialization values selected by the command line.
 */
function parseAgentOptions(args: string[]): AgentCliOptions {
  const { values } = parseArgs({
    args,
    options: {
      instructions: { type: "string" },
      log: { type: "boolean", default: false },
      session: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  let instructions: string | undefined;
  if (values.instructions !== undefined) {
    const path = resolve(process.cwd(), values.instructions);
    try {
      instructions = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`无法读取系统提示词文件：${path}`, { cause: error });
    }
  }

  return {
    ...(instructions === undefined ? {} : { instructions }),
    log: values.log ?? false,
    ...(values.session === undefined ? {} : { sessionId: values.session }),
  };
}

/**
 * Prints the latest user/model turn loaded from a persisted session.
 * @param agent Agent whose conversation may contain restored session items.
 * @param sessionId CLI-selected session identifier, or undefined for a new session.
 */
function printSessionHistory(agent: Agent, sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  const messages = agent.conversation.items.filter(isVisibleConversationItem);
  if (messages.length === 0) return;

  let latestTurnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== "user") continue;
    latestTurnStart = index;
    break;
  }
  if (latestTurnStart < 0) latestTurnStart = messages.length - 1;
  while (latestTurnStart > 0 && messages[latestTurnStart - 1]?.role === "user") {
    latestTurnStart -= 1;
  }

  if (latestTurnStart > 0) {
    process.stdout.write(`还有 ${latestTurnStart} 条历史消息\n\n`);
  }
  for (const item of messages.slice(latestTurnStart)) {
    const title = item.role === "user" ? "你  › " : "🤖  WallE";
    const color = item.role === "user" ? ANSI_CYAN : ANSI_GREEN;
    process.stdout.write(`${paint(title, `${ANSI_BOLD}${color}`)}\n${conversationText(item)}\n\n`);
  }
}

/**
 * Checks whether a retained conversation item belongs in the visible transcript.
 * @param item Retained conversation item to inspect.
 * @returns Whether the item represents user- or model-visible content.
 */
function isVisibleConversationItem(item: ConversationItem): item is VisibleConversationItem {
  return item.type === "text" || item.type === "image" || item.type === "file";
}

/**
 * Formats a visible conversation item for terminal output.
 * @param item Visible text, image, or file conversation item.
 * @returns Human-readable terminal content.
 */
function conversationText(item: VisibleConversationItem): string {
  if (item.type === "text") return item.text;
  if (item.type === "image") return `[图片] ${item.image}`;
  return `[文件] ${item.file}`;
}

/**
 * Runs one user turn against the persistent Agent conversation.
 * @param agent Agent shared by every REPL turn.
 * @param printer Incremental Agent output renderer.
 * @param input User message for the current turn.
 * @param logger Optional session logger enabled by the command line.
 * @returns Completion after all ReAct rounds finish.
 */
async function runTurn(
  agent: Agent,
  printer: AgentPrinter,
  input: string,
  logger?: SessionLogger,
): Promise<void> {
  try {
    logger?.request(input);
    for await (const event of agent.query(model, input)) {
      printer.write(event);
      if (
        event.type === "agent.response.completed"
        || event.type === "agent.response.failed"
        || event.type === "agent.response.incomplete"
      ) {
        logger?.response(event.response);
      }
    }
  } catch (error) {
    process.stdout.write(`${paint("✗ Agent 错误", ANSI_RED)}\n${
      error instanceof Error ? error.message : String(error)
    }\n`);
  } finally {
    printer.finishTurn();
  }
}

/**
 * Runs a multi-turn REPL backed by a real model and real local tools.
 * @returns Completion after the user exits the REPL.
 */
async function main(): Promise<void> {
  const { instructions, log, sessionId } = parseAgentOptions(process.argv.slice(2));
  const apiKey = process.env.ARK_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("缺少 ARK_API_KEY；模型调用必须使用真实 API");
  }
  const llm = new Connector(
    baseUrl,
    apiKey.replace(/^Bearer\s+/i, ""),
    new ResponsesAPIConverter(),
  );
  const panel = new ToolPanel();
  const tools = new DisplayTools(panel, [new BashTool({ cwd: process.cwd() })]);
  const agent = new Agent({ llm, tools, instructions, sessionId });
  const logger = log ? new SessionLogger(agent.conversation.id) : undefined;
  const printer = new AgentPrinter();
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  const originalConsoleLog = console.log;
  console.log = () => undefined;
  try {
    process.stdout.write(
      `${paint("╭──────────────────────────────────────╮", ANSI_CYAN)}\n`
      + `${paint("│  WallE Agent                         │", `${ANSI_BOLD}${ANSI_CYAN}`)}\n`
      + `${paint("│  输入 /exit 或 /quit 结束会话        │", ANSI_CYAN)}\n`
      + `${paint("╰──────────────────────────────────────╯", ANSI_CYAN)}\n`,
    );
    printSessionHistory(agent, sessionId);
    readline.setPrompt(`${paint("\n你  › ", `${ANSI_BOLD}${ANSI_CYAN}`)}`);
    readline.prompt();
    for await (const line of readline) {
      const input = line.trim();
      if (input === "/exit" || input === "/quit") break;
      if (input !== "") await runTurn(agent, printer, input, logger);
      readline.prompt();
    }
  } finally {
    readline.close();
    console.log = originalConsoleLog;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
