import { createInterface } from "node:readline";
import {
  Agent,
  BashTool,
  Connector,
  ResponsesAPIConverter,
  Tools,
  type AgentEvent,
  type ResponseFunctionCall,
} from "walle";

const baseUrl = "https://ark.cn-beijing.volces.com/api/v3/responses";
const model = "doubao-seed-evolving";
const ANSI_RESET = "\u001B[0m";
const ANSI_BOLD = "\u001B[1m";
const ANSI_CYAN = "\u001B[36m";
const ANSI_DIM = "\u001B[2m";
const ANSI_GREEN = "\u001B[32m";
const ANSI_MAGENTA = "\u001B[35m";
const ANSI_RED = "\u001B[31m";

/** Mutable terminal representation of one tool call. */
interface ToolRecord {
  /** Provider item identifier when one was supplied. */
  itemId?: string;
  /** Agent-provided call identifier. */
  callId: string;
  /** Registered tool name. */
  name: string;
  /** Agent-provided JSON argument text. */
  arguments: string;
  /** Current execution status. */
  status: "等待执行" | "执行中" | "已完成" | "执行失败";
  /** Tool result or failure message. */
  result?: unknown;
}

/** Live, replaceable terminal panel for one parallel batch of tool calls. */
class ToolPanel {
  private readonly records: ToolRecord[] = [];
  private activeExecutions = 0;
  private savedCursor = false;
  private collapseVersion = 0;

  /**
   * Adds or updates tool calls emitted by the Agent.
   * @param calls Complete function-call snapshots from the current response.
   */
  public sync(calls: ResponseFunctionCall[]): void {
    for (const call of calls) {
      const existing = this.records.find(({ callId }) => callId === call.call_id);
      if (existing === undefined) {
        this.records.push({
          itemId: call.id,
          callId: call.call_id,
          name: call.name,
          arguments: call.arguments,
          status: "等待执行",
        });
      } else {
        existing.name = call.name;
        existing.arguments = call.arguments;
      }
    }
    this.render();
  }

  /**
   * Marks the matching pending tool as executing.
   * @param name Registered tool name.
   * @param parameters JSON-encoded tool arguments.
   * @returns Mutable record associated with this execution.
   */
  public begin(name: string, parameters: string): ToolRecord {
    const record = this.records.find((candidate) => (
      candidate.status === "等待执行"
      && candidate.name === name
      && candidate.arguments === parameters
    )) ?? {
      callId: `tool-${this.records.length + 1}`,
      name,
      arguments: parameters,
      status: "等待执行" as const,
    };
    if (!this.records.includes(record)) this.records.push(record);
    record.status = "执行中";
    this.activeExecutions += 1;
    this.collapseVersion += 1;
    this.render();
    return record;
  }

  /**
   * Records one successful or failed tool result and schedules batch collapse.
   * @param record Tool record returned by begin().
   * @param result Tool result or normalized failure message.
   * @param failed Whether execution failed.
   */
  public complete(record: ToolRecord, result: unknown, failed: boolean): void {
    record.status = failed ? "执行失败" : "已完成";
    record.result = result === undefined ? "undefined" : result;
    this.activeExecutions -= 1;
    this.render();
    const version = ++this.collapseVersion;
    queueMicrotask(() => {
      if (this.activeExecutions === 0 && version === this.collapseVersion) this.collapse();
    });
  }

  /** Replaces the live tool details with a compact execution count. */
  private collapse(): void {
    const summary = `${paint("✓", ANSI_GREEN)} 已执行 ${this.records.length} 次工具`;
    if (process.stdout.isTTY && this.savedCursor) {
      process.stdout.write(`\u001B[u\u001B[J${summary}\n`);
    } else {
      process.stdout.write(`${this.content()}${summary}\n`);
    }
    this.records.length = 0;
    this.savedCursor = false;
  }

  /** Refreshes the replaceable tool panel in an interactive terminal. */
  private render(): void {
    if (this.records.length === 0 || !process.stdout.isTTY) return;
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
    const tools = this.records.map((record) => JSON.stringify({
      type: "function_call",
      ...(record.itemId === undefined ? {} : { id: record.itemId }),
      call_id: record.callId,
      name: record.name,
      arguments: parseToolArguments(record.arguments),
      status: record.status,
      ...(record.result === undefined ? {} : { result: record.result }),
    }, undefined, 2)).join("\n");
    return `${paint("🛠  工具", ANSI_CYAN)}\n${paint(tools, ANSI_DIM)}\n`;
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
   * Executes a registered tool while reporting its result to the panel.
   * @param name Registered tool name selected by the model.
   * @param parameters JSON-encoded tool arguments selected by the model.
   * @returns The registered tool's response.
   */
  public override async exec(name: string, parameters: string): Promise<unknown> {
    const record = this.panel.begin(name, parameters);
    try {
      const result = await super.exec(name, parameters);
      this.panel.complete(record, result, false);
      return result;
    } catch (error) {
      this.panel.complete(
        record,
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
      throw error;
    }
  }
}

/** Incremental renderer for Agent reasoning and answer snapshots. */
class AgentPrinter {
  private thinking = "";
  private answer = "";
  private section: "thinking" | "answer" | undefined;

  /**
   * Creates a printer connected to the shared tool panel.
   * @param panel Tool panel used for function-call snapshots.
   */
  public constructor(private readonly panel: ToolPanel) {}

  /**
   * Streams newly available reasoning, answer, and tool-call content.
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

    const calls = event.response.output.filter(
      (item): item is ResponseFunctionCall => item.type === "function_call",
    );
    if (calls.length > 0) {
      this.finishSection();
      this.panel.sync(calls);
    }

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
 * Parses tool arguments for friendlier terminal output without affecting execution.
 * @param parameters JSON-encoded tool arguments.
 * @returns Parsed JSON, or the original text when malformed.
 */
function parseToolArguments(parameters: string): unknown {
  try {
    return JSON.parse(parameters) as unknown;
  } catch {
    return parameters;
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
 * Runs one user turn against the persistent Agent conversation.
 * @param agent Agent shared by every REPL turn.
 * @param printer Incremental Agent output renderer.
 * @param input User message for the current turn.
 * @returns Completion after all ReAct rounds finish.
 */
async function runTurn(agent: Agent, printer: AgentPrinter, input: string): Promise<void> {
  try {
    for await (const event of agent.query(model, input)) printer.write(event);
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
  const agent = new Agent({ llm, tools });
  const printer = new AgentPrinter(panel);
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
    readline.setPrompt(`${paint("\n你  › ", `${ANSI_BOLD}${ANSI_CYAN}`)}`);
    readline.prompt();
    for await (const line of readline) {
      const input = line.trim();
      if (input === "/exit" || input === "/quit") break;
      if (input !== "") await runTurn(agent, printer, input);
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
