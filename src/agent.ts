import type {
  FunctionCallOutput,
  Optional,
  Response,
  ResponseEvent,
  ResponseCustomToolCall,
  ResponseFunctionCall,
} from "@maozy13/neuralink";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  Conversation,
  fromModelOutput,
  fromUserInput,
} from "./conversation.js";
import { createBashTool } from "./tools/bash.js";
import { Tools } from "./tools/tools.js";
import type { Memory } from "./memory.js";
import { Skills } from "./skills.js";
import type {
  AgentEvent,
  AgentInput,
  AgentOptions,
  AgentQuery,
  AgentQueryOptions,
} from "./typings/agent.js";

/** WallE runtime coordinating NeuralLink conversations with registered tools. */
export class Agent {
  public readonly instructions: string;
  public readonly llm: AgentOptions["llm"];
  public readonly conversation: Conversation;
  public readonly tools: Tools;
  public readonly memory?: Memory;
  private readonly cwd: string;
  private readonly home?: string;

  /**
   * Creates an agent backed by a NeuralLink-compatible connector.
   * @param options Model connector, system instructions, conversation, tools, memory, and paths.
   */
  public constructor(options: AgentOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.home = options.home;
    this.instructions = options.instructions ?? "";
    this.llm = options.llm;
    this.conversation = options.conversation
      ?? new Conversation([], options.sessionId, join(this.cwd, ".walle"));
    if (options.sessionId !== undefined) this.conversation.read(options.sessionId);
    this.tools = options.tools
      ?? new Tools([createBashTool({ cwd: options.cwd })]);
    this.memory = options.memory;
    if (this.memory !== undefined) this.tools.register(this.memory.retrieveTool());
    const skills = new Skills(this.cwd, this.home);
    if (skills.skills.size > 0) this.tools.register(skills.activationTool());
  }

  /**
   * Runs a multi-round ReAct loop and streams normalized WallE events.
   * @param model Provider model identifier.
   * @param input Plain text or structured NeuralLink input.
   * @param optional Optional provider-neutral model settings.
   * @returns WallE response events and the final NeuralLink response.
   */
  public async *query(
    model: string,
    input: AgentInput,
    optional: AgentQueryOptions = {},
  ): AgentQuery {
    const runId = randomUUID();
    yield { type: "agent.run.created", run_id: runId };
    const firstTaskItem = this.conversation.items.length;
    let modelInput = this.conversation.append(fromUserInput(input));
    const modelOptions = this.createModelOptions(optional);

    try {
      while (true) {
        const response = yield* this.call(model, modelInput, modelOptions, runId);
        this.conversation.append(fromModelOutput(response.output));
        const calls = response.output.filter(
          (item): item is ResponseFunctionCall => item.type === "function_call",
        );
        if (response.status !== "completed" || calls.length === 0) return response;

        const outputs = await Promise.all(calls.map((call) => this.execute(call)));
        modelInput = this.conversation.append(outputs.map((output) => ({
          ...output,
          role: "tool" as const,
        })));
      }
    } finally {
      if (this.memory !== undefined && this.memory.adapters.size > 0) {
        await this.updateMemory(
          model,
          structuredClone(this.conversation.items.slice(firstTaskItem)),
          this.memory,
        );
      }
    }
  }

  /**
   * Runs an independent task-local Agent that evaluates and performs memory updates.
   * @param model Provider model identifier used by the completed primary task.
   * @param taskItems Conversation items produced by the completed primary task only.
   * @param memory Memory registry used to construct the task-local update tool.
   * @returns Completion after the memory Agent exits its own ReAct lifecycle.
   */
  private async updateMemory(
    model: string,
    taskItems: typeof this.conversation.items,
    memory: Memory,
  ): Promise<void> {
    const agent = new Agent({
      llm: this.llm,
      instructions: memory.updateInstructions(),
      conversation: new Conversation(taskItems, undefined, join(this.cwd, ".walle")),
      tools: new Tools([memory.updateTool()]),
      cwd: this.cwd,
      ...(this.home === undefined ? {} : { home: this.home }),
    });
    const query = agent.query(model, "请根据以上会话上下文判断并完成记忆更新。");
    while (!(await query.next()).done) {
      // The memory Agent has an independent lifecycle and produces no public events.
    }
  }

  /**
   * Calls NeuralLink once and maps its native events to WallE response events.
   * @param model Provider model identifier.
   * @param input Complete conversation input for this round.
   * @param optional Model settings including registered tools.
   * @param runId Stable identifier of the current Agent task.
   * @returns WallE response events and the round's final response.
   */
  private async *call(
    model: string,
    input: ReturnType<Conversation["read"]>,
    optional: Optional,
    runId: string,
  ): AgentQuery {
    const stream = this.llm.call(model, input, optional);
    let accumulated: Response | undefined;
    while (true) {
      const next = await stream.next();
      if (next.done) return next.value;
      const mapped = mapEvent(next.value, accumulated, runId);
      accumulated = mapped.response;
      if (mapped.event !== undefined) yield mapped.event;
    }
  }

  /**
   * Combines caller options with the registered NeuralLink tool schemas.
   * @param optional Caller-supplied model options.
   * @returns Model options containing the Agent's current tools.
   */
  private createModelOptions(optional: AgentQueryOptions): Optional {
    const instructions = [
      this.instructions,
      optional.instructions,
    ]
      .filter((value): value is string => value !== undefined && value !== "")
      .join("\n\n");
    return {
      ...optional,
      ...(instructions === "" ? {} : { instructions }),
      tools: this.tools.list(),
    };
  }

  /**
   * Executes one native NeuralLink function call.
   * @param call Function call accumulated by NeuralLink.
   * @returns Function output associated by call ID.
   */
  private async execute(
    call: ResponseFunctionCall,
  ): Promise<FunctionCallOutput> {
    try {
      const output = await this.tools.exec(call.name, call.arguments);
      return {
        type: "function_call_output",
        call_id: call.call_id,
        output: serialize(output),
      };
    } catch (error) {
      return {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
}

/**
 * Maps a NeuralLink event and advances a detached response snapshot.
 * @param event Native NeuralLink event.
 * @param previous Previously accumulated response snapshot.
 * @param runId Stable identifier of the current Agent task.
 * @returns Updated response and its optional public WallE event.
 */
function mapEvent(
  event: ResponseEvent,
  previous: Response | undefined,
  runId: string,
): { response: Response; event?: AgentEvent } {
  if (event.type === "response.created") {
    const response = cloneResponse(event.response);
    return { response, event: createEvent("agent.response.created", response, runId) };
  }
  if (event.type === "response.completed") {
    const response = cloneResponse(event.response);
    const types = new Set(response.output.map(({ type }) => type));
    const type = types.has("function_call")
      ? "agent.function_call.completed"
      : types.has("custom_tool_call")
        ? "agent.custom_tool_call.completed"
        : "agent.run.completed";
    return { response, event: createEvent(type, response, runId) };
  }
  if (event.type === "response.failed") {
    const response = cloneResponse(event.response);
    return { response, event: createEvent("agent.run.failed", response, runId) };
  }
  if (event.type === "response.incomplete") {
    const response = cloneResponse(event.response);
    return { response, event: createEvent("agent.run.incomplete", response, runId) };
  }
  if (previous === undefined) {
    throw new Error(`NeuralLink emitted ${event.type} before response.created`);
  }

  const response = cloneResponse(previous);
  applyChange(response, event);
  if (event.type === "response.reasoning_text.delta"
    || event.type === "response.reasoning_summary_text.delta") {
    return { response, event: createEvent("agent.reasoning.changed", response, runId) };
  }
  if (event.type === "response.message_text.delta"
    || event.type === "response.message_refusal.delta") {
    return { response, event: createEvent("agent.message.changed", response, runId) };
  }
  return { response };
}

/**
 * Applies one NeuralLink output-change event to an accumulated response.
 * @param response Mutable detached response snapshot.
 * @param event NeuralLink output-change event.
 */
function applyChange(
  response: Response,
  event: Exclude<ResponseEvent, { type: `response.${"created" | "completed" | "failed" | "incomplete"}` }>,
): void {
  if (event.type === "response.function_call.added") {
    response.output.push(structuredClone(event.function_call));
    return;
  }
  if (event.type === "response.function_call_arguments.delta") {
    const call = response.output
      .filter((item): item is ResponseFunctionCall => item.type === "function_call")[event.index];
    if (call === undefined) throw new Error(`Unknown function call index ${event.index}`);
    call.arguments += event.delta;
    return;
  }
  if (event.type === "response.custom_tool_call.added") {
    response.output.push(structuredClone(event.custom_tool_call));
    return;
  }
  if (event.type === "response.custom_tool_call_input.delta") {
    const call = response.output
      .filter((item): item is ResponseCustomToolCall => item.type === "custom_tool_call")[event.index];
    if (call === undefined) throw new Error(`Unknown custom tool call index ${event.index}`);
    call.input += event.delta;
    return;
  }
  if (event.type === "response.reasoning_text.delta") {
    const items = response.output.filter((item) => item.type === "reasoning");
    const item = items[event.index];
    if (item === undefined) {
      requireNextIndex(event.index, items.length, event.type);
      response.output.push({
        type: "reasoning",
        content: { type: "reasoning_text", text: event.delta },
        summary: { type: "summary_text", text: "" },
      });
    } else {
      item.content.text += event.delta;
    }
    return;
  }
  if (event.type === "response.reasoning_summary_text.delta") {
    const items = response.output.filter((item) => item.type === "reasoning");
    const item = items[event.index];
    if (item === undefined) {
      requireNextIndex(event.index, items.length, event.type);
      response.output.push({
        type: "reasoning",
        content: { type: "reasoning_text", text: "" },
        summary: { type: "summary_text", text: event.delta },
      });
    } else {
      item.summary.text += event.delta;
    }
    return;
  }

  const contentType = event.type === "response.message_refusal.delta"
    ? "refusal"
    : "output_text";
  const items = response.output.filter(
    (item) => item.type === "message" && item.content.type === contentType,
  );
  const item = items[event.index];
  if (item === undefined) {
    requireNextIndex(event.index, items.length, event.type);
    response.output.push(event.type === "response.message_refusal.delta"
      ? { type: "message", role: "assistant", content: { type: "refusal", refusal: event.delta } }
      : { type: "message", role: "assistant", content: { type: "output_text", text: event.delta } });
  } else if (item.type === "message" && item.content.type === "output_text") {
    item.content.text += event.delta;
  } else if (item.type === "message" && item.content.type === "refusal") {
    item.content.refusal += event.delta;
  }
}

/**
 * Validates that a new indexed output is contiguous.
 * @param index Event-provided item index.
 * @param length Existing number of same-kind items.
 * @param type Event type used in the error message.
 */
function requireNextIndex(index: number, length: number, type: string): void {
  if (index !== length) throw new Error(`NeuralLink emitted ${type} for unknown index ${index}`);
}

/**
 * Creates a WallE event around a response snapshot.
 * @param type WallE event discriminator.
 * @param response Detached response snapshot.
 * @param runId Stable identifier of the current Agent task.
 * @returns Normalized WallE event.
 */
function createEvent(
  type: Exclude<AgentEvent["type"], "agent.run.created">,
  response: Response,
  runId: string,
): AgentEvent {
  return { type, run_id: runId, id: response.id ?? "", response } as AgentEvent;
}

/**
 * Clones a response so emitted events remain immutable snapshots.
 * @param response Response to clone.
 * @returns Detached response value.
 */
function cloneResponse(response: Response): Response {
  return structuredClone(response);
}

/**
 * Serializes a tool output for NeuralLink function-call input.
 * @param value Tool output value.
 * @returns String or JSON representation of the output.
 */
function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}
