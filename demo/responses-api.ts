import {
  Agent,
  Connector,
  ResponsesAPIConverter,
  type AgentEvent,
} from "walle";

const baseUrl = "https://ark.cn-beijing.volces.com/api/v3/responses";
const model = "doubao-seed-evolving";

/**
 * Writes user-visible text from one normalized model event.
 * @param event NeuralLink response event emitted by WallE.
 */
function writeText(event: AgentEvent): void {
  if (event.type === "agent.response.changed") {
    const text = event.response.output
      .filter((item) => item.type === "message" && item.content.type === "output_text")
      .map((item) => item.type === "message" && item.content.type === "output_text" ? item.content.text : "")
      .join("");
    process.stdout.write(`\r${text}`);
  }
}

/**
 * Runs a real Responses API conversation through WallE.
 * @returns A promise resolved after the streaming response completes.
 */
async function main(): Promise<void> {
  const apiKey = process.env.ARK_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new Error("缺少 ARK_API_KEY；DEMO 只使用真实 API，不提供 Mock 回退");
  }

  const llm = new Connector(
    baseUrl,
    apiKey.replace(/^Bearer\s+/i, ""),
    new ResponsesAPIConverter(),
  );
  const agent = new Agent({ llm });

  for await (const event of agent.query(
    model,
    "请使用 bash 工具执行 wc -l package.json，并告诉我这个项目的 package.json 一共有多少行。",
  )) {
    writeText(event);
  }
  process.stdout.write("\n");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
