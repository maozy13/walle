import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCliConfig, runCli } from "./cli.js";

/** Temporary directories created by the current test module. */
const directories: string[] = [];

/**
 * Creates an isolated CLI working directory.
 * @returns Absolute temporary directory path.
 */
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "walle-cli-"));
  directories.push(directory);
  return directory;
}

/**
 * Creates a writable stream that retains all UTF-8 output.
 * @returns Writable destination and a function returning accumulated output.
 */
function outputBuffer(): { output: Writable; text: () => string } {
  let contents = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      contents += chunk.toString();
      callback();
    },
  });
  return { output, text: () => contents };
}

/**
 * Creates a fetch mock returning a Responses API-compatible SSE stream.
 * @param events Provider events emitted as individual SSE records.
 * @param inspect Optional observer for the outgoing request.
 * @returns Fetch-compatible mock implementation.
 */
function modelFetch(
  events: object[],
  inspect?: (input: string | URL | Request, init?: RequestInit) => void,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    inspect?.(input, init);
    const source = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(source, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

/**
 * Builds a complete streamed text lifecycle.
 * @param text Visible assistant text.
 * @param terminal Terminal provider event type.
 * @returns Responses API source events.
 */
function textLifecycle(
  text: string,
  terminal: "response.completed" | "response.failed" | "response.incomplete" = "response.completed",
): object[] {
  const status = terminal === "response.completed"
    ? "completed"
    : terminal === "response.failed" ? "failed" : "incomplete";
  return [
    { type: "response.created", response: { id: "r1", created_at: 1 } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    {
      type: terminal,
      response: {
        id: "r1",
        created_at: 1,
        status,
        output: [{
          id: "m1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        }],
      },
    },
  ];
}

/**
 * Builds a lifecycle containing streamed reasoning followed by an answer.
 * @param reasoning Streamed reasoning summary.
 * @param answer Streamed final answer.
 * @returns Responses API source events.
 */
function reasoningLifecycle(reasoning: string, answer: string): object[] {
  return [
    { type: "response.created", response: { id: "reasoning", created_at: 1 } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: reasoning },
    { type: "response.in_progress", sequence_number: 3 },
    { type: "response.output_item.added", output_index: 1, item: { type: "message" } },
    { type: "response.output_text.delta", output_index: 1, delta: answer },
    {
      type: "response.completed",
      response: {
        id: "reasoning",
        created_at: 1,
        status: "completed",
        output: [
          {
            id: "thinking",
            type: "reasoning",
            content: [],
            summary: [{ type: "summary_text", text: reasoning }],
          },
          {
            id: "answer",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: answer }],
          },
        ],
      },
    },
  ];
}

/**
 * Builds a completed response that selects one function tool.
 * @param name Selected tool name.
 * @returns Responses API source events.
 */
function toolLifecycle(name: string): object[] {
  const item = {
    id: "tool-item",
    type: "function_call",
    call_id: "tool-call",
    name,
    arguments: "{}",
  };
  return [
    { type: "response.created", response: { id: "tool-response", created_at: 1 } },
    { type: "response.output_item.added", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "tool-response",
        created_at: 1,
        status: "completed",
        output: [item],
      },
    },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveCliConfig", () => {
  it("merges WALLE.md, workspace walle.json, and explicit command-line overrides", () => {
    const cwd = temporaryDirectory();
    const home = temporaryDirectory();
    mkdirSync(join(home, ".walle", "walle.json"), { recursive: true });
    writeFileSync(join(cwd, "WALLE.md"), "default instruction", "utf8");
    writeFileSync(join(cwd, "walle.json"), JSON.stringify({
      baseUrl: "https://config.test/responses",
      model: "config-model",
      apiKey: "config-key",
      instruction: "config instruction",
      session: "saved-session",
      log: true,
    }), "utf8");

    expect(resolveCliConfig([
      "--base-url", "https://cli.test/responses",
      "--model", "cli-model",
      "--api-key", "cli-key",
      "--instruction", "cli instruction",
      "--session", "cli-session",
      "--no-log",
    ], cwd, home)).toEqual({
      baseUrl: "https://cli.test/responses",
      model: "cli-model",
      apiKey: "cli-key",
      instruction: "cli instruction",
      session: "cli-session",
      log: false,
    });
  });

  it("uses the home configuration only when the workspace configuration is absent", () => {
    const cwd = temporaryDirectory();
    const home = temporaryDirectory();
    mkdirSync(join(home, ".walle"));
    writeFileSync(join(home, ".walle", "walle.json"), JSON.stringify({
      baseUrl: "https://home.test/responses",
      model: "home-model",
      apiKey: "home-key",
      log: true,
    }), "utf8");

    expect(resolveCliConfig([], cwd, home)).toEqual({
      baseUrl: "https://home.test/responses",
      model: "home-model",
      apiKey: "home-key",
      log: true,
    });
  });

  it("selects the workspace configuration as a whole without merging the home file", () => {
    const cwd = temporaryDirectory();
    const home = temporaryDirectory();
    mkdirSync(join(cwd, ".walle"));
    mkdirSync(join(home, ".walle"));
    writeFileSync(join(cwd, ".walle", "walle.json"), JSON.stringify({
      baseUrl: "https://nested.test/responses",
      model: "nested-model",
      apiKey: "nested-key",
    }), "utf8");
    writeFileSync(join(home, ".walle", "walle.json"), JSON.stringify({
      baseUrl: "https://home.test/responses",
      model: "home-model",
      apiKey: "home-key",
    }), "utf8");
    writeFileSync(join(cwd, "walle.json"), JSON.stringify({ model: "workspace-model" }), "utf8");

    expect(() => resolveCliConfig([], cwd, home)).toThrow("Invalid CLI configuration");
  });

  it("uses WALLE.md and a false logging default when optional config is absent", () => {
    const cwd = temporaryDirectory();
    const home = temporaryDirectory();
    writeFileSync(join(cwd, "WALLE.md"), "workspace instruction", "utf8");

    expect(resolveCliConfig([
      "--base-url=https://api.test/responses",
      "--model=model",
      "--api-key=key",
    ], cwd, home)).toEqual({
      baseUrl: "https://api.test/responses",
      model: "model",
      apiKey: "key",
      instruction: "workspace instruction",
      log: false,
    });
  });

  it("ignores a legacy .walle file when checking the nested configuration path", () => {
    const cwd = temporaryDirectory();
    const home = temporaryDirectory();
    writeFileSync(join(cwd, ".walle"), "legacy configuration", "utf8");

    expect(resolveCliConfig([
      "--base-url=https://api.test/responses",
      "--model=model",
      "--api-key=key",
    ], cwd, home)).toEqual({
      baseUrl: "https://api.test/responses",
      model: "model",
      apiKey: "key",
      log: false,
    });
  });

  it("returns no configuration for help before reading workspace files", () => {
    expect(resolveCliConfig(["--help"], join(temporaryDirectory(), "missing"))).toBeUndefined();
  });

  it("reports malformed, unsupported, unreadable, and incomplete configuration", () => {
    const home = temporaryDirectory();
    const malformed = temporaryDirectory();
    writeFileSync(join(malformed, "walle.json"), "{", "utf8");
    expect(() => resolveCliConfig([], malformed, home)).toThrow("malformed JSON");

    const unsupported = temporaryDirectory();
    writeFileSync(join(unsupported, "walle.json"), JSON.stringify({ extra: true }), "utf8");
    expect(() => resolveCliConfig([], unsupported, home)).toThrow("Invalid configuration file");

    const unreadable = temporaryDirectory();
    mkdirSync(join(unreadable, "walle.json"));
    expect(() => resolveCliConfig([], unreadable, home)).toThrow();

    expect(() => resolveCliConfig([], temporaryDirectory(), home)).toThrow("Invalid CLI configuration");
    expect(() => resolveCliConfig(["positional"], temporaryDirectory(), home)).toThrow();
  });
});

describe("runCli", () => {
  it("prints help without calling the model API", async () => {
    const buffer = outputBuffer();
    const fetchImplementation = vi.fn();
    await runCli(["--help"], {
      cwd: temporaryDirectory(),
      input: Readable.from([]),
      output: buffer.output,
      fetch: fetchImplementation,
    });

    expect(buffer.text()).toContain("Usage: walle");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("creates the session log immediately when logging is enabled", async () => {
    const cwd = temporaryDirectory();
    const buffer = outputBuffer();

    await runCli([
      "--base-url", "https://api.test/responses",
      "--model", "model",
      "--api-key", "key",
      "--log",
    ], {
      cwd,
      input: Readable.from(["/exit\n"]),
      output: buffer.output,
      fetch: vi.fn() as unknown as typeof fetch,
    });

    const files = readdirSync(join(cwd, "logs"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.log$/u);
    expect(readFileSync(join(cwd, "logs", files[0]!), "utf8")).toBe("");
  });

  it("runs a real Connector turn, streams output, persists the session, and logs records", async () => {
    const cwd = temporaryDirectory();
    const buffer = outputBuffer();
    writeFileSync(join(cwd, "WALLE.md"), "Be concise", "utf8");
    let requestBody: Record<string, unknown> | undefined;
    const fetchImplementation = modelFetch(textLifecycle("Hello"), (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    });

    await runCli([
      "--base-url", "https://api.test/responses",
      "--model", "test-model",
      "--api-key", "secret",
      "--log",
    ], {
      cwd,
      input: Readable.from(["\nhello\n/exit\n"]),
      output: buffer.output,
      fetch: fetchImplementation,
    });

    expect(buffer.text()).toContain("🤖 Hello");
    expect(requestBody).toMatchObject({ model: "test-model", instructions: "Be concise", stream: true });
    expect(readdirSync(join(cwd, "sessions"))).toHaveLength(1);
    const logFile = readdirSync(join(cwd, "logs"))[0];
    expect(logFile).toMatch(/\.log$/u);
    const records = readFileSync(join(cwd, "logs", logFile!), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(records.map(({ type }) => type)).toEqual(["request", "response"]);
  });

  it("formats streamed reasoning, folds its duration, and filters unsupported events", async () => {
    const cwd = temporaryDirectory();
    const buffer = outputBuffer();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1500);

    await runCli([
      "--base-url", "https://api.test/responses",
      "--model", "model",
      "--api-key", "key",
    ], {
      cwd,
      input: Readable.from(["question\n/exit\n"]),
      output: buffer.output,
      fetch: modelFetch(reasoningLifecycle("分析", "答案")),
      now,
    });

    expect(buffer.text()).toContain("🤖 [思考中...]分析\n🤖 [已思考 2 秒]\n🤖 答案");
    expect(log).not.toHaveBeenCalled();
  });

  it("folds multiline reasoning in a terminal and prints only tool names", async () => {
    const cwd = temporaryDirectory();
    const buffer = outputBuffer();
    Object.assign(buffer.output, { isTTY: true });
    const fetchImplementation = vi.fn()
      .mockImplementationOnce(modelFetch(toolLifecycle("missing_tool")))
      .mockImplementationOnce(modelFetch(reasoningLifecycle("第一行\n第二行", "完成")));

    await runCli([
      "--base-url", "https://api.test/responses",
      "--model", "model",
      "--api-key", "key",
    ], {
      cwd,
      input: Readable.from(["question\n/quit\n"]),
      output: buffer.output,
      fetch: fetchImplementation as unknown as typeof fetch,
      now: vi.fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(500),
    });

    expect(buffer.text()).toContain("🤖 [使用工具]missing_tool\n");
    expect(buffer.text()).not.toContain("tool-call");
    expect(buffer.text()).not.toContain("{}");
    expect(buffer.text()).toContain("\u001B[1A\r\u001B[2K");
    expect(buffer.text()).toContain("🤖 [已思考 1 秒]\n🤖 完成");
  });

  it("restores a configured session, handles refusals, and exits with /quit", async () => {
    const cwd = temporaryDirectory();
    const sessionDirectory = join(cwd, ".walle", "sessions", "existing");
    mkdirSync(join(sessionDirectory, "ARCHIVES"), { recursive: true });
    writeFileSync(join(sessionDirectory, "CONVERSATION.md"), "", "utf8");
    writeFileSync(join(cwd, ".walle", "walle.json"), JSON.stringify({
      baseUrl: "https://api.test/responses",
      model: "model",
      apiKey: "key",
      session: "existing",
      log: false,
    }), "utf8");
    const buffer = outputBuffer();
    const events = [
      { type: "response.created", response: { id: "r2", created_at: 2 } },
      { type: "response.content_part.added", output_index: 0, part: { type: "refusal" } },
      {
        type: "response.failed",
        response: {
          id: "r2",
          created_at: 2,
          status: "failed",
          output: [{
            id: "m2",
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "No" }],
          }],
        },
      },
    ];

    await runCli([], {
      cwd,
      input: Readable.from(["question\n/quit\n"]),
      output: buffer.output,
      fetch: modelFetch(events),
    });

    expect(buffer.text()).toContain("No");
    expect(() => readdirSync(join(cwd, "logs"))).toThrow();
  });

  it("closes the REPL when a model request fails", async () => {
    const cwd = temporaryDirectory();
    const buffer = outputBuffer();
    const fetchImplementation = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(runCli([
      "--base-url", "https://api.test/responses",
      "--model", "model",
      "--api-key", "key",
    ], {
      cwd,
      input: Readable.from(["hello\n"]),
      output: buffer.output,
      fetch: fetchImplementation,
    })).rejects.toThrow("network down");
  });
});
