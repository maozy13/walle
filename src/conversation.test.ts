import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Conversation,
  type ConversationItem,
  type ConversationItemInput,
  type ResponseOutputItem,
} from "./index.js";
import { fromModelOutput, fromUserInput } from "./conversation.js";

let cwd: string;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * Removes generated metadata so item-specific normalization can be asserted clearly.
 * @param items Complete retained conversation items.
 * @returns Item-specific fields in their original order.
 */
function withoutMetadata(items: ConversationItem[]): ConversationItemInput[] {
  return items.map(({ id: _id, created_at: _createdAt, ...item }) => item);
}

/**
 * Verifies that every item has unique, locally generated metadata.
 * @param items Complete retained conversation items.
 * @param earliest Earliest accepted creation timestamp.
 * @param latest Latest accepted creation timestamp.
 */
function expectMetadata(
  items: ConversationItem[],
  earliest: number,
  latest: number,
): void {
  expect(new Set(items.map(({ id }) => id))).toHaveLength(items.length);
  for (const item of items) {
    expect(item.id).toMatch(UUID_PATTERN);
    expect(item.created_at).toBeGreaterThanOrEqual(earliest);
    expect(item.created_at).toBeLessThanOrEqual(latest);
  }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "walle-conversation-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("Conversation", () => {
  it("copies initial items, appends items, and returns detached model input", () => {
    const initial: ConversationItemInput[] = [{ type: "text", role: "user", text: "one" }];
    const conversation = new Conversation(initial, "conversation-id", cwd);
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
    expect(conversation.context()).toHaveLength(5);
    expect(conversation.id).toBe("conversation-id");
  });

  it("persists every item as separated Markdown and reads it without loss", () => {
    const items: ConversationItemInput[] = [
      { type: "text", role: "user", text: "line one\n---\nline two" },
      { type: "image", role: "assistant", image: "https://image" },
      { type: "file", role: "user", file: "file:///document" },
      { type: "reasoning", role: "assistant", content: "details", summary: "summary" },
      { type: "function_call", role: "assistant", call_id: "call", name: "tool", arguments: "{}" },
      { type: "function_call_output", role: "tool", call_id: "call", output: "ok" },
    ];
    const conversation = new Conversation([], "saved-session", cwd);

    conversation.append(items);

    const session = join(cwd, "sessions", "saved-session");
    const markdown = readFileSync(join(session, "CONVERSATION.md"), "utf8");
    expect(existsSync(join(session, "ARCHIVES"))).toBe(true);
    expect(markdown.match(/^---$/gmu)).toHaveLength(items.length - 1);
    expect(markdown).not.toContain("```json");
    expect(markdown).toMatch(/^\{\n  "id": ".+",\n  "created_at": \d+,\n  "type": "text"/u);

    const loaded = new Conversation([
      { type: "text", role: "user", text: "replace me" },
    ], "old-session", cwd);
    expect(loaded.read("saved-session")).toEqual(conversation.context());
    expect(loaded.items).toEqual(conversation.items);
    expect(loaded.id).toBe("saved-session");
  });

  it("persists and reads an empty conversation", () => {
    const conversation = new Conversation([], "empty", cwd);

    expect(conversation.append([])).toEqual([]);
    expect(readFileSync(join(cwd, "sessions", "empty", "CONVERSATION.md"), "utf8"))
      .toBe("");
    expect(new Conversation([], "other", cwd).read("empty")).toEqual([]);
  });

  it("reads legacy fenced JSON and rewrites it as direct JSON when appended", () => {
    const path = join(cwd, "sessions", "legacy");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "CONVERSATION.md"),
      "```json\n{\"type\":\"text\",\"role\":\"user\",\"text\":\"old\"}\n```\n",
      "utf8",
    );
    const conversation = new Conversation([], "other", cwd);

    conversation.read("legacy");
    conversation.append([{ type: "text", role: "assistant", text: "new" }]);

    const markdown = readFileSync(join(path, "CONVERSATION.md"), "utf8");
    expect(withoutMetadata(conversation.items)).toEqual([
      { type: "text", role: "user", text: "old" },
      { type: "text", role: "assistant", text: "new" },
    ]);
    expect(markdown).not.toContain("```json");
  });

  it.each([
    ["plain text", "malformed JSON"],
    ["{broken}", "malformed JSON"],
    ["{\"type\":\"unknown\"}", "unsupported item shape"],
    ["null", "unsupported item shape"],
    ["{}", "unsupported item shape"],
  ])("retains existing state when persisted Markdown is invalid: %#", (markdown, message) => {
    const path = join(cwd, "sessions", "broken");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "CONVERSATION.md"), markdown, "utf8");
    const conversation = new Conversation([
      { type: "text", role: "user", text: "existing" },
    ], "original", cwd);
    const existing = structuredClone(conversation.items);

    expect(() => conversation.read("broken")).toThrow(message);
    expect(conversation.id).toBe("original");
    expect(conversation.items).toEqual(existing);
  });

  it("retains existing state when the requested session does not exist", () => {
    const conversation = new Conversation([
      { type: "text", role: "assistant", text: "existing" },
    ], "original", cwd);
    const existing = structuredClone(conversation.items);

    expect(() => conversation.read("missing")).toThrow();
    expect(conversation.id).toBe("original");
    expect(conversation.items).toEqual(existing);
  });

  it.each(["", ".", "..", "nested/id", "nested\\id"])(
    "rejects unsafe session ID %j and rolls back appended items",
    (id) => {
      const conversation = new Conversation([], id, cwd);
      expect(() => conversation.append([
        { type: "text", role: "user", text: "not retained" },
      ])).toThrow("Invalid session ID");
      expect(conversation.items).toEqual([]);
    },
  );

  it("rolls back appended items when the session cannot be written", () => {
    const blockedCwd = join(cwd, "file");
    writeFileSync(blockedCwd, "not a directory", "utf8");
    const conversation = new Conversation([], "session", blockedCwd);

    expect(() => conversation.append([
      { type: "text", role: "user", text: "not retained" },
    ])).toThrow();
    expect(conversation.items).toEqual([]);
  });

  it("normalizes plain and every structured user input kind", () => {
    const earliest = Date.now();
    const plain = fromUserInput("hello");
    expect(withoutMetadata(plain)).toEqual([
      { type: "text", role: "user", text: "hello" },
    ]);
    const structured = fromUserInput([
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
    ]);
    expect(withoutMetadata(structured)).toEqual([
      { type: "text", role: "assistant", text: "answer" },
      { type: "image", role: "assistant", image: "image" },
      { type: "file", role: "user", file: "file" },
      { type: "function_call", role: "assistant", call_id: "call", name: "tool", arguments: "{}" },
      { type: "function_call_output", role: "tool", call_id: "call", output: "ok" },
    ]);
    expectMetadata([...plain, ...structured], earliest, Date.now());
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

    const earliest = Date.now();
    const normalized = fromModelOutput(output);
    expect(withoutMetadata(normalized)).toEqual([
      { type: "text", role: "assistant", text: "answer" },
      { type: "text", role: "assistant", text: "no" },
      { type: "reasoning", role: "assistant", content: "details", summary: "summary" },
      { type: "function_call", role: "assistant", call_id: "call", name: "tool", arguments: "{}" },
    ]);
    expectMetadata(normalized, earliest, Date.now());
  });

  it("preserves supplied metadata and rejects incomplete persisted metadata", () => {
    const supplied: ConversationItem = {
      id: "fixed-id",
      created_at: 123,
      type: "text",
      role: "user",
      text: "existing",
    };
    const conversation = new Conversation([supplied], "metadata", cwd);
    conversation.append([supplied]);
    expect(conversation.items).toEqual([supplied, supplied]);

    const path = join(cwd, "sessions", "invalid-metadata");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "CONVERSATION.md"),
      '{"id":"partial","type":"text","role":"user","text":"broken"}',
      "utf8",
    );
    expect(() => conversation.read("invalid-metadata")).toThrow("unsupported item shape");
  });
});
