import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  Conversation,
  Memory,
  Tools,
  type AgentEvent,
  type Response,
  type ResponseEvent,
  type ResponseFunctionCall,
  type ToolDef,
  type MemoryAdapter,
} from "./index.js";

/**
 * Creates an accumulated response with supplied output and status.
 * @param output Normalized model output items.
 * @param status Response lifecycle status.
 * @param id Stable response identifier.
 * @returns NeuralLink response.
 */
function response(
  output: Response["output"] = [],
  status: Response["status"] = "completed",
  id = "response-1",
): Response {
  return { id, created_at: 1, status, output };
}

/**
 * Creates a deterministic model response stream.
 * @param final Accumulated response returned at stream completion.
 * @param events Events yielded before completion.
 * @returns NeuralLink-compatible response stream.
 */
async function* stream(
  final: Response,
  events: ResponseEvent[] = [],
): AsyncGenerator<ResponseEvent, Response> {
  for (const event of events) yield event;
  return final;
}

/**
 * Creates a normal lifecycle event stream for one response.
 * @param final Final response.
 * @param changes Output-change events between creation and termination.
 * @returns NeuralLink-compatible response stream.
 */
function lifecycle(
  final: Response,
  changes: ResponseEvent[] = [],
): AsyncGenerator<ResponseEvent, Response> {
  const created = response([], "in_progress");
  created.id = final.id;
  const terminal: ResponseEvent = final.status === "failed"
    ? { type: "response.failed", response: final }
    : final.status === "incomplete"
      ? { type: "response.incomplete", sequence_number: 1, response: final }
      : { type: "response.completed", response: final };
  return stream(final, [
    { type: "response.created", response: created },
    ...changes,
    terminal,
  ]);
}

/**
 * Creates a native NeuralLink function call.
 * @param callId Stable call identifier.
 * @param name Selected tool name.
 * @param argumentsText JSON-encoded function arguments.
 * @returns Normalized function call.
 */
function functionCall(
  callId: string,
  name: string,
  argumentsText = "{}",
): ResponseFunctionCall {
  return {
    id: `item-${callId}`,
    type: "function_call",
    call_id: callId,
    name,
    arguments: argumentsText,
  };
}

/**
 * Creates a test tool definition.
 * @param name Stable tool name.
 * @param fc Tool implementation.
 * @returns Tool metadata and implementation.
 */
function tool(name: string, fc: ToolDef["fc"]): ToolDef {
  return {
    schema: {
      type: "function",
      name,
      description: "test tool",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    fc,
  };
}

/**
 * Consumes an agent query while retaining yielded events and its return value.
 * @param query Agent query to consume.
 * @returns Emitted events and final response.
 */
async function consume(
  query: ReturnType<Agent["query"]>,
): Promise<{ events: AgentEvent[]; final: Response }> {
  const events: AgentEvent[] = [];
  while (true) {
    const next = await query.next();
    if (next.done) return { events, final: next.value };
    events.push(next.value);
  }
}

describe("Agent", () => {
  let testCwd: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    testCwd = mkdtempSync(join(tmpdir(), "walle-agent-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(testCwd);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(testCwd, { recursive: true, force: true });
  });

  it("maps lifecycle and delta events while retaining the conversation", async () => {
    const final = response([{
      type: "message",
      role: "assistant",
      content: { type: "output_text", text: "你好" },
    }]);
    const call = vi.fn(() => lifecycle(final, [
      { type: "response.message_text.delta", index: 0, delta: "你" },
      { type: "response.message_text.delta", index: 0, delta: "好" },
    ]));
    const conversation = new Conversation();
    const result = await consume(new Agent({
      llm: { call },
      tools: new Tools(),
      conversation,
    }).query("model", "你好", { instructions: "简短回答" }));

    expect(result.events.map(({ type }) => type)).toEqual([
      "agent.response.created",
      "agent.response.changed",
      "agent.response.changed",
      "agent.response.completed",
    ]);
    expect(result.events[1]?.response.output).toEqual([expect.objectContaining({
      content: { type: "output_text", text: "你" },
    })]);
    expect(result.events[2]?.response.output).toEqual([expect.objectContaining({
      content: { type: "output_text", text: "你好" },
    })]);
    expect(result.events.every(({ id }) => id === "response-1")).toBe(true);
    expect(result.final).toBe(final);
    expect(call).toHaveBeenCalledWith("model", [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "你好" }],
    }], { instructions: "简短回答", tools: [] });
    expect(conversation.items).toEqual([
      expect.objectContaining({ type: "text", role: "user", text: "你好" }),
      expect.objectContaining({ type: "text", role: "assistant", text: "你好" }),
    ]);
  });

  it("advertises the default native bash tool", async () => {
    const call = vi.fn(() => stream(response([])));
    await consume(new Agent({
      llm: { call },
      cwd: "/workspace",
      conversation: new Conversation([], "test", testCwd),
    })
      .query("model", "run"));

    expect(call.mock.calls[0]?.[2].tools).toEqual([
      expect.objectContaining({ type: "function", name: "bash" }),
    ]);
  });

  it("loads a requested session when constructed", async () => {
    new Conversation([], "existing", testCwd).append([
      { type: "text", role: "user", text: "historical" },
    ]);
    const call = vi.fn(() => stream(response([])));
    const agent = new Agent({
      llm: { call },
      tools: new Tools(),
      cwd: testCwd,
      sessionId: "existing",
    });

    await consume(agent.query("model", "current"));

    expect(agent.conversation.id).toBe("existing");
    expect(call.mock.calls[0]?.[1]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "historical" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "current" }] },
    ]);
  });

  it("injects constructor and query instructions into every model round", async () => {
    const selected = functionCall("call-1", "value");
    const call = vi.fn()
      .mockImplementationOnce(() => stream(response([selected])))
      .mockImplementationOnce(() => stream(response([])));
    const agent = new Agent({
      llm: { call },
      tools: new Tools([tool("value", () => "ok")]),
      instructions: "Agent system instructions",
    });

    await consume(agent.query("model", "run", { instructions: "Turn instructions" }));

    expect(agent.instructions).toBe("Agent system instructions");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls.every((invocation) => (
      invocation[2].instructions === "Agent system instructions\n\nTurn instructions"
    ))).toBe(true);
  });

  it("retrieves memory and updates adapters with only the current task", async () => {
    const retrieve = vi.fn(() => ({ language: "中文" }));
    const update = vi.fn();
    const adapter: MemoryAdapter = {
      name: "profile",
      description: "用户画像",
      retrieve,
      update,
    };
    const selected = functionCall(
      "memory-call",
      "memory.retrieve",
      '{"name":"profile","query":"语言偏好"}',
    );
    const call = vi.fn()
      .mockImplementationOnce(() => stream(response([selected])))
      .mockImplementationOnce(() => stream(response([])));
    const conversation = new Conversation([
      { type: "text", role: "user", text: "historical" },
    ], "conversation-id");
    const tools = new Tools();
    const exec = vi.spyOn(tools, "exec");
    const agent = new Agent({
      llm: { call },
      tools,
      memory: new Memory([adapter]),
      conversation,
    });

    await consume(agent.query("model", "current"));

    expect(call.mock.calls[0]?.[2].tools).toEqual([
      expect.objectContaining({ name: "memory.retrieve" }),
    ]);
    expect(retrieve).toHaveBeenCalledWith("语言偏好");
    expect(exec).toHaveBeenCalledWith(
      "memory.retrieve",
      '{"name":"profile","query":"语言偏好"}',
    );
    expect(call.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([{
      type: "function_call_output",
      call_id: "memory-call",
      output: '{"language":"中文"}',
    }]));
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[0]).toMatchObject({
      conversation: {
        id: "conversation-id",
        items: [
          { type: "text", role: "user", text: "current" },
          expect.objectContaining({ type: "function_call", name: "memory.retrieve" }),
          expect.objectContaining({ type: "function_call_output" }),
        ],
      },
      metadata: { model: "model" },
    });
    expect(update.mock.calls[0]?.[0].conversation.items).not.toContainEqual(
      expect.objectContaining({ text: "historical" }),
    );
  });

  it("reserves the memory retrieval tool name when memory is enabled", () => {
    expect(() => new Agent({
      llm: { call: () => stream(response()) },
      tools: new Tools([tool("memory.retrieve", vi.fn())]),
      memory: new Memory(),
    })).toThrow('Tool "memory.retrieve" is already registered');
  });

  it.each([
    ["invalid", "Tool parameters must be valid JSON"],
    ["null", "Tool parameters must be a JSON object"],
    ["[]", "Tool parameters must be a JSON object"],
  ])(
    "returns malformed memory call failures through tool output: %s",
    async (argumentsText, expectedError) => {
      const selected = functionCall("memory-call", "memory.retrieve", argumentsText);
      const call = vi.fn()
        .mockImplementationOnce(() => stream(response([selected])))
        .mockImplementationOnce(() => stream(response([])));

      await consume(new Agent({
        llm: { call },
        tools: new Tools(),
        memory: new Memory(),
      }).query("model", "run"));

      expect(call.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          output: expect.stringContaining(expectedError),
        }),
      ]));
    },
  );

  it("updates memory when model execution throws", async () => {
    const update = vi.fn();
    const memory = new Memory([{
      name: "profile",
      description: "用户画像",
      retrieve: vi.fn(),
      update,
    }]);
    const agent = new Agent({
      llm: { call: () => {
        throw new Error("model failed");
      } },
      tools: new Tools(),
      memory,
    });

    await expect(consume(agent.query("model", "run"))).rejects.toThrow("model failed");
    expect(update).toHaveBeenCalledOnce();
  });

  it("runs repeated and parallel tool calls with complete conversation context", async () => {
    const firstCalls = [
      functionCall("call-1", "value", "{\"value\":1}"),
      functionCall("call-2", "value", "{\"value\":2}"),
    ];
    const secondCall = functionCall("call-3", "value", "{\"value\":3}");
    const final = response([{
      type: "message",
      role: "assistant",
      content: { type: "output_text", text: "done" },
    }], "completed", "response-3");
    const fc = vi.fn(({ value }) => ({ doubled: Number(value) * 2 }));
    const tools = new Tools([tool("value", fc)]);
    const call = vi.fn()
      .mockImplementationOnce(() => lifecycle(response(firstCalls, "completed", "response-1")))
      .mockImplementationOnce(() => lifecycle(response([secondCall], "completed", "response-2")))
      .mockImplementationOnce(() => lifecycle(final));
    const agent = new Agent({ llm: { call }, tools });

    const result = await consume(agent.query("model", "run"));

    expect(result.final).toBe(final);
    expect(call).toHaveBeenCalledTimes(3);
    expect(fc).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({ type: "message", role: "user" }),
      ...firstCalls.map(({ id: _id, ...item }) => item),
      { type: "function_call_output", call_id: "call-1", output: "{\"doubled\":2}" },
      { type: "function_call_output", call_id: "call-2", output: "{\"doubled\":4}" },
    ]);
    expect(call.mock.calls[2]?.[1]).toEqual(expect.arrayContaining([
      { type: "function_call_output", call_id: "call-3", output: "{\"doubled\":6}" },
    ]));
    expect(agent.conversation.items.at(-1)).toEqual(expect.objectContaining({
      type: "text",
      role: "assistant",
      text: "done",
    }));
  });

  it.each([
    [new Error("tool failed"), "tool failed"],
    ["non-error failure", "non-error failure"],
  ])("returns tool failures through conversation output", async (failure, message) => {
    const selected = functionCall("call-1", "broken");
    const tools = new Tools([tool("broken", () => {
      throw failure;
    })]);
    const call = vi.fn()
      .mockImplementationOnce(() => stream(response([selected])))
      .mockImplementationOnce(() => stream(response([])));

    await consume(new Agent({ llm: { call }, tools }).query("model", "run"));

    const output = (call.mock.calls[1]?.[1] as unknown[]).at(-1);
    expect(output).toMatchObject({
      type: "function_call_output",
      call_id: "call-1",
    });
    expect(JSON.stringify(output)).toContain(message);
  });

  it("serializes string and undefined tool outputs", async () => {
    const calls = [
      functionCall("call-1", "text"),
      functionCall("call-2", "empty"),
    ];
    const tools = new Tools([
      tool("text", () => "plain"),
      tool("empty", () => undefined),
    ]);
    const call = vi.fn()
      .mockImplementationOnce(() => stream(response(calls)))
      .mockImplementationOnce(() => stream(response([])));

    await consume(new Agent({ llm: { call }, tools }).query("model", "run"));

    expect(call.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      { type: "function_call_output", call_id: "call-1", output: "plain" },
      { type: "function_call_output", call_id: "call-2", output: "undefined" },
    ]));
  });

  it("maps refusal, reasoning, function-call, failed, and incomplete events", async () => {
    const added = functionCall("call", "missing", "");
    const failed = response([], "failed", "failed-id");
    const incomplete = response([], "incomplete");
    const call = vi.fn()
      .mockImplementationOnce(() => lifecycle(failed, [
        { type: "response.message_refusal.delta", index: 0, delta: "不" },
        { type: "response.message_refusal.delta", index: 0, delta: "行" },
        { type: "response.reasoning_summary_text.delta", index: 0, delta: "思" },
        { type: "response.reasoning_summary_text.delta", index: 0, delta: "考" },
        { type: "response.function_call.added", function_call: added },
        { type: "response.function_call_arguments.delta", index: 0, delta: "{}" },
      ]))
      .mockImplementationOnce(() => lifecycle(incomplete));
    const agent = new Agent({ llm: { call }, tools: new Tools() });

    const first = await consume(agent.query("model", "one"));
    const second = await consume(agent.query("model", "two"));

    expect(first.events.at(-1)?.type).toBe("agent.response.failed");
    expect(first.events[2]?.response.output).toEqual([expect.objectContaining({
      content: { type: "refusal", refusal: "不行" },
    })]);
    expect(first.events[4]?.response.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: { type: "summary_text", text: "思考" } }),
    ]));
    expect(first.events[6]?.response.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", arguments: "{}" }),
    ]));
    expect(second.events.at(-1)?.type).toBe("agent.response.incomplete");
  });

  it.each([
    [[{ type: "response.message_text.delta", index: 0, delta: "x" }], "before response.created"],
    [[
      { type: "response.created", response: response([], "in_progress") },
      { type: "response.message_text.delta", index: 1, delta: "x" },
    ], "unknown index 1"],
    [[
      { type: "response.created", response: response([], "in_progress") },
      { type: "response.message_refusal.delta", index: 1, delta: "x" },
    ], "unknown index 1"],
    [[
      { type: "response.created", response: response([], "in_progress") },
      { type: "response.reasoning_summary_text.delta", index: 1, delta: "x" },
    ], "unknown index 1"],
    [[
      { type: "response.created", response: response([], "in_progress") },
      { type: "response.function_call_arguments.delta", index: 0, delta: "{}" },
    ], "Unknown function call index 0"],
  ] as const)("rejects invalid event sequences %#", async (events, message) => {
    const call = vi.fn(() => stream(response([]), [...events] as ResponseEvent[]));

    await expect(consume(new Agent({ llm: { call }, tools: new Tools() })
      .query("model", "run"))).rejects.toThrow(message);
  });

  it("uses an empty event id when the provider omits a response id", async () => {
    const final = response();
    delete final.id;
    const { events } = await consume(new Agent({
      llm: { call: () => lifecycle(final) },
      tools: new Tools(),
    }).query("model", "run"));

    expect(events.every(({ id }) => id === "")).toBe(true);
  });
});
