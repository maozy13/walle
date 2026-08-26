import { describe, expect, it } from "vitest";
import {
  Conversation,
  type ConversationItem,
  type ResponseOutputItem,
} from "./index.js";
import { fromModelOutput, fromUserInput } from "./conversation.js";

describe("Conversation", () => {
  it("copies initial items, appends items, and returns detached model input", () => {
    const initial: ConversationItem[] = [{ type: "text", role: "user", text: "one" }];
    const conversation = new Conversation(initial, "conversation-id");
    initial[0] = { type: "text", role: "user", text: "changed" };

    const input = conversation.append([
      { type: "image", role: "user", image: "https://image" },
      { type: "file", role: "assistant", file: "https://file" },
      { type: "reasoning", role: "assistant", content: "private", summary: "public" },
      { type: "function_call", role: "assistant", call_id: "call", name: "tool", arguments: "{}" },
      { type: "function_call_output", role: "tool", call_id: "call", output: "ok" },
    ]);

    expect(input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://image" }] },
      { type: "message", role: "assistant", content: [{ type: "input_file", file_url: "https://file" }] },
      { type: "function_call", call_id: "call", name: "tool", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: "ok" },
    ]);
    input.length = 0;
    expect(conversation.read()).toHaveLength(5);
    expect(conversation.id).toBe("conversation-id");
  });

  it("normalizes plain and every structured user input kind", () => {
    expect(fromUserInput("hello")).toEqual([
      { type: "text", role: "user", text: "hello" },
    ]);
    expect(fromUserInput([
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "input_text", text: "answer" },
          { type: "input_image", image_url: "image" },
        ],
      },
      { type: "message", role: "system", content: [{ type: "input_file", file_url: "file" }] },
      { type: "function_call", call_id: "call", name: "tool", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: "ok" },
    ])).toEqual([
      { type: "text", role: "assistant", text: "answer" },
      { type: "image", role: "assistant", image: "image" },
      { type: "file", role: "user", file: "file" },
      { type: "function_call", role: "assistant", call_id: "call", name: "tool", arguments: "{}" },
      { type: "function_call_output", role: "tool", call_id: "call", output: "ok" },
    ]);
  });

  it("normalizes every model output kind in order", () => {
    const output: ResponseOutputItem[] = [
      { type: "message", role: "assistant", content: { type: "output_text", text: "answer" } },
      { type: "message", role: "assistant", content: { type: "refusal", refusal: "no" } },
      {
        type: "reasoning",
        content: { type: "reasoning_text", text: "details" },
        summary: { type: "summary_text", text: "summary" },
      },
      { id: "item", type: "function_call", call_id: "call", name: "tool", arguments: "{}" },
    ];

    expect(fromModelOutput(output)).toEqual([
      { type: "text", role: "assistant", text: "answer" },
      { type: "text", role: "assistant", text: "no" },
      { type: "reasoning", role: "assistant", content: "details", summary: "summary" },
      { type: "function_call", role: "assistant", call_id: "call", name: "tool", arguments: "{}" },
    ]);
  });
});
