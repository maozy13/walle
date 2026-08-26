import {
  Agent,
  Connector,
  Memory,
  ResponsesAPIConverter,
  type AgentOptions,
  type InputItem,
  type MemoryAdapter,
  type MemoryContext,
  type Optional,
  type Response,
  type ResponseEvent,
} from "walle";

const baseUrl = "https://ark.cn-beijing.volces.com/api/v3/responses";
const model = "doubao-seed-evolving";

/** Mock user-profile memory backed by an in-process fixture. */
class MockUserProfileMemoryAdapter implements MemoryAdapter {
  public readonly name = "user-profile";
  public readonly description = "查询用户的身份、偏好、职责和沟通习惯。";

  /**
   * Returns the mock user's profile memory.
   * @param query Model-selected profile query.
   * @returns Matching user-profile content.
   */
  public retrieve(query: string): unknown {
    const result = {
      query,
      profile: {
        name: "小瓦",
        role: "Agent 运行时框架开发者",
        language: "中文",
        responseStyle: "先给结论，再说明关键依据",
      },
    };
    printSection("记忆工具执行结果：user-profile", result);
    return result;
  }

  /**
   * Accepts task context without persisting it in this read-only mock.
   * @param context Completed task context supplied by WallE.
   */
  public update(context: MemoryContext): void {
    void context;
  }
}

/** Mock glossary memory backed by an in-process fixture. */
class MockTermsMemoryAdapter implements MemoryAdapter {
  public readonly name = "terms";
  public readonly description = "查询 WallE 项目术语、缩写及其定义。";

  /**
   * Returns glossary entries relevant to a query.
   * @param query Model-selected terminology query.
   * @returns Matching glossary content.
   */
  public retrieve(query: string): unknown {
    const terms = {
      WallE: "一个基于 neuralink 的 Agent 运行时框架。",
      MemoryAdapter: "负责从特定记忆系统召回内容并接收任务上下文更新的适配器。",
      ReAct: "模型选择工具、执行工具、回传结果并继续推理的循环。",
    };
    const matched = Object.entries(terms).filter(([term]) =>
      query.toLocaleLowerCase().includes(term.toLocaleLowerCase())
    );
    const result = {
      query,
      terms: Object.fromEntries(matched.length === 0 ? Object.entries(terms) : matched),
    };
    printSection("记忆工具执行结果：terms", result);
    return result;
  }

  /**
   * Accepts task context without persisting it in this read-only mock.
   * @param context Completed task context supplied by WallE.
   */
  public update(context: MemoryContext): void {
    void context;
  }
}

/**
 * Prints one labeled JSON-compatible demo value.
 * @param title Human-readable output section title.
 * @param value Value serialized below the title.
 */
function printSection(title: string, value: unknown): void {
  process.stdout.write(`\n=== ${title} ===\n${JSON.stringify(value, null, 2)}\n`);
}

/** NeuralLink-compatible model wrapper that logs every complete request and response. */
class LoggingLlm {
  private requestIndex = 0;

  /**
   * Creates a logging wrapper around a NeuralLink-compatible model connector.
   * @param llm Underlying model connector that performs the real API calls.
   */
  public constructor(private readonly llm: AgentOptions["llm"]) {}

  /**
   * Logs one complete normalized request and its accumulated response.
   * @param modelName Provider model identifier.
   * @param input Complete model input for the current Agent round.
   * @param optional Provider-neutral model options, including memory tools.
   * @returns Original streaming events and final accumulated response.
   */
  public async *call(
    modelName: string,
    input: string | InputItem[],
    optional: Optional = {},
  ): AsyncGenerator<ResponseEvent, Response> {
    const index = ++this.requestIndex;
    printSection(`LLM 请求 #${index}`, { model: modelName, input, ...optional });
    const stream = this.llm.call(modelName, input, optional);
    while (true) {
      const next = await stream.next();
      if (next.done) {
        printSection(`LLM 响应 #${index}`, next.value);
        return next.value;
      }
      yield next.value;
    }
  }
}

/**
 * Runs a real model with two mock-backed memory systems.
 * @returns Completion after the streaming response finishes.
 */
async function main(): Promise<void> {
  const apiKey = process.env.ARK_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("缺少 ARK_API_KEY；模型调用必须使用真实 API");
  }
  const connector = new Connector(
    baseUrl,
    apiKey.replace(/^Bearer\s+/i, ""),
    new ResponsesAPIConverter(),
  );
  const llm = new LoggingLlm(connector);
  const memory = new Memory([
    new MockUserProfileMemoryAdapter(),
    new MockTermsMemoryAdapter(),
  ]);
  const agent = new Agent({ llm, memory });

  const originalConsoleLog = console.log;
  console.log = () => undefined;
  try {
    for await (const _event of agent.query(
      model,
      "向我介绍 WallE 项目的 MemoryAdapter",
    )) {
      // Iteration drives the streaming query; LoggingLlm records each completed round.
    }
  } finally {
    console.log = originalConsoleLog;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
