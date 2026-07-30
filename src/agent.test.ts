import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  type Response,
  type ResponseEvent,
} from "./index.js";

const completedResponse: Response = {
  id: "response-1",
  created_at: 1,
  status: "completed",
  output: [],
};

/**
 * Creates a deterministic model stream.
 * @param events Events yielded before completion.
 * @returns A response stream returning the shared completed response.
 */
async function* stream(events: ResponseEvent[]): AsyncGenerator<ResponseEvent, Response> {
  for (const event of events) yield event;
  return completedResponse;
}

describe("Agent", () => {
  it("forwards query arguments, streams events, and returns the response", async () => {
    const event: ResponseEvent = {
      type: "response.message_text.delta",
      delta: "你好",
    };
    const call = vi.fn(() => stream([event]));
    const query = new Agent({ llm: { call } }).query(
      "model",
      "你好",
      { instructions: "简短回答" },
    );

    expect(await query.next()).toEqual({ done: false, value: event });
    expect(await query.next()).toEqual({ done: true, value: completedResponse });
    expect(call).toHaveBeenCalledWith(
      "model",
      "你好",
      { instructions: "简短回答" },
    );
  });

  it("uses empty optional settings by default", async () => {
    const call = vi.fn(() => stream([]));
    const query = new Agent({ llm: { call } }).query("model", []);

    expect(await query.next()).toEqual({ done: true, value: completedResponse });
    expect(call).toHaveBeenCalledWith("model", [], {});
  });
});
