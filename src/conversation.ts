import type {
  InputItem,
  ResponseOutputItem,
} from "@maozy13/neuralink";
import type {
  ConversationInput,
  ConversationItem,
  ConversationItemInput,
} from "./typings/conversation.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const CONVERSATION_FILE = "CONVERSATION.md";
const ARCHIVES_DIRECTORY = "ARCHIVES";
const ITEM_SEPARATOR = "\n\n---\n\n";

/** Ordered multi-turn context owned by a WallE agent. */
export class Conversation {
  public id: string;
  public readonly items: ConversationItem[];
  private readonly cwd: string;

  /**
   * Creates a conversation with optional existing items.
   * @param items Initial conversation items in chronological order.
   * @param id Stable conversation identity; generated when omitted.
   * @param cwd Working directory containing the sessions directory.
   */
  public constructor(
    items: ConversationItemInput[] = [],
    id: string = randomUUID(),
    cwd: string = process.cwd(),
  ) {
    this.id = id;
    this.items = items.map(withMetadata);
    this.cwd = resolve(cwd);
  }

  /**
   * Converts the retained conversation to NeuralLink model input.
   * @returns A detached NeuralLink-compatible input array.
   */
  public context(): ConversationInput {
    return this.items.flatMap(toInputItem);
  }

  /**
   * Appends items and returns the complete NeuralLink-compatible conversation.
   * @param items Conversation items to append in chronological order.
   * @returns A detached NeuralLink-compatible input array.
   */
  public append(items: ConversationItemInput[]): ConversationInput {
    const originalLength = this.items.length;
    this.items.push(...items.map(withMetadata));
    try {
      this.persist();
      return this.context();
    } catch (error) {
      this.items.length = originalLength;
      throw error;
    }
  }

  /**
   * Loads a persisted session and returns its NeuralLink-compatible context.
   * Existing state is changed only after the complete file has been parsed.
   * @param sessionId Identifier of the session to load.
   * @returns A detached NeuralLink-compatible input array.
   */
  public read(sessionId: string): ConversationInput {
    const path = this.sessionPath(sessionId);
    const loaded = parseConversation(readFileSync(join(path, CONVERSATION_FILE), "utf8"));
    this.id = sessionId;
    this.items.splice(0, this.items.length, ...loaded);
    return this.context();
  }

  /** Writes the complete conversation and ensures its archive directory exists. */
  private persist(): void {
    const path = this.sessionPath(this.id);
    mkdirSync(join(path, ARCHIVES_DIRECTORY), { recursive: true });
    writeFileSync(
      join(path, CONVERSATION_FILE),
      serializeConversation(this.items),
      "utf8",
    );
  }

  /**
   * Resolves a session directory without allowing the identifier to escape it.
   * @param sessionId Session identifier used as one directory name.
   * @returns Absolute session directory path.
   */
  private sessionPath(sessionId: string): string {
    if (
      sessionId.length === 0
      || sessionId === "."
      || sessionId === ".."
      || basename(sessionId) !== sessionId
      || sessionId.includes("\\")
    ) {
      throw new Error(`Invalid session ID: ${JSON.stringify(sessionId)}`);
    }
    return join(this.cwd, "sessions", sessionId);
  }
}

/**
 * Encodes conversation items as JSON objects separated by thematic rules.
 * @param items Conversation items to encode.
 * @returns Markdown representation of the complete conversation.
 */
function serializeConversation(items: ConversationItem[]): string {
  if (items.length === 0) return "";
  return `${items.map((item) => JSON.stringify(item, undefined, 2)).join(ITEM_SEPARATOR)}\n`;
}

/**
 * Parses and validates all conversation items from persisted Markdown.
 * @param markdown Persisted conversation Markdown.
 * @returns Validated conversation items in file order.
 */
function parseConversation(markdown: string): ConversationItem[] {
  if (markdown.trim().length === 0) return [];
  return markdown.trim().split(/\r?\n\r?\n---\r?\n\r?\n/u).map((block, index) => {
    const legacy = /^```json\r?\n([\s\S]*)\r?\n```$/u.exec(block);
    let value: unknown;
    try {
      value = JSON.parse(legacy?.[1] ?? block);
    } catch (error) {
      throw new Error(`Invalid conversation item ${index + 1}: malformed JSON`, { cause: error });
    }
    if (!isConversationItemShape(value)) {
      throw new Error(`Invalid conversation item ${index + 1}: unsupported item shape`);
    }
    if (hasMetadataFields(value) && !hasValidMetadata(value)) {
      throw new Error(`Invalid conversation item ${index + 1}: unsupported item shape`);
    }
    return hasValidMetadata(value) ? value : withMetadata(value);
  });
}

/**
 * Checks whether an unknown persisted value has a supported item-specific shape.
 * @param value Value decoded from one JSON block.
 * @returns Whether the value conforms to a conversation item shape without considering metadata.
 */
function isConversationItemShape(value: unknown): value is ConversationItemInput {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const item = value as Record<string, unknown>;
  switch (item.type) {
    case "text":
      return isConversationRole(item.role) && typeof item.text === "string";
    case "image":
      return isConversationRole(item.role) && typeof item.image === "string";
    case "file":
      return isConversationRole(item.role) && typeof item.file === "string";
    case "reasoning":
      return item.role === "assistant"
        && typeof item.content === "string"
        && typeof item.summary === "string";
    case "function_call":
      return item.role === "assistant"
        && typeof item.call_id === "string"
        && typeof item.name === "string"
        && typeof item.arguments === "string";
    case "function_call_output":
      return item.role === "tool"
        && typeof item.call_id === "string"
        && typeof item.output === "string";
    default:
      return false;
  }
}

/**
 * Checks whether either local metadata field is present on a decoded item.
 * @param value Decoded conversation item.
 * @returns Whether the item contains at least one metadata field.
 */
function hasMetadataFields(value: ConversationItemInput): boolean {
  return "id" in value || "created_at" in value;
}

/**
 * Checks whether both local metadata fields have valid primitive values.
 * @param value Decoded conversation item.
 * @returns Whether the item is a complete retained conversation item.
 */
function hasValidMetadata(value: ConversationItemInput): value is ConversationItem {
  return "id" in value
    && typeof value.id === "string"
    && value.id.length > 0
    && "created_at" in value
    && typeof value.created_at === "number"
    && Number.isFinite(value.created_at);
}

/**
 * Adds locally generated metadata when an inserted item does not already contain it.
 * @param item Conversation item supplied by a caller or normalization function.
 * @returns Complete retained conversation item.
 */
function withMetadata(item: ConversationItemInput): ConversationItem {
  if (hasValidMetadata(item)) return item;
  return {
    id: randomUUID(),
    created_at: Date.now(),
    ...item,
  } as ConversationItem;
}

/**
 * Checks a user-visible conversation role.
 * @param value Candidate item role.
 * @returns Whether the role is supported for user-visible content.
 */
function isConversationRole(value: unknown): value is "user" | "assistant" {
  return value === "user" || value === "assistant";
}

/**
 * Normalizes user-supplied NeuralLink input into conversation items.
 * @param input Plain text or structured NeuralLink input.
 * @returns Normalized conversation items.
 */
export function fromUserInput(input: string | InputItem[]): ConversationItem[] {
  if (typeof input === "string") {
    return [withMetadata({ type: "text", role: "user", text: input })];
  }
  return input.flatMap(fromInputItem);
}

/**
 * Normalizes completed model output into conversation items.
 * @param output Completed NeuralLink response output.
 * @returns Normalized conversation items in model order.
 */
export function fromModelOutput(output: ResponseOutputItem[]): ConversationItem[] {
  return output.map((item): ConversationItem => {
    if (item.type === "function_call") {
      return withMetadata({
        type: "function_call",
        role: "assistant",
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
    if (item.type === "reasoning") {
      return withMetadata({
        type: "reasoning",
        role: "assistant",
        content: item.content.text,
        summary: item.summary.text,
      });
    }
    return withMetadata({
      type: "text",
      role: "assistant",
      text: item.content.type === "output_text"
        ? item.content.text
        : item.content.refusal,
    });
  });
}

/**
 * Converts NeuralLink input into retained conversation items.
 * @param item NeuralLink input item.
 * @returns Normalized conversation items in content-block order.
 */
function fromInputItem(item: InputItem): ConversationItem[] {
  if (item.type === "function_call") {
    return [withMetadata({ ...item, role: "assistant" })];
  }
  if (item.type === "function_call_output") {
    return [withMetadata({ ...item, role: "tool" })];
  }
  const role = item.role === "assistant" ? "assistant" : "user";
  return item.content.map((content): ConversationItem => {
    if (content.type === "input_image") {
      return withMetadata({ type: "image", role, image: content.image_url });
    }
    if (content.type === "input_file") {
      return withMetadata({ type: "file", role, file: content.file_url });
    }
    return withMetadata({ type: "text", role, text: content.text });
  });
}

/**
 * Converts one conversation item into zero or one NeuralLink input items.
 * @param item Conversation item to convert.
 * @returns Empty for non-replayable reasoning, otherwise one input item.
 */
function toInputItem(item: ConversationItem): InputItem[] {
  switch (item.type) {
    case "text":
      return [{
        type: "message",
        role: item.role,
        content: [{ type: "input_text", text: item.text }],
      }];
    case "image":
      return [{
        type: "message",
        role: item.role,
        content: [{ type: "input_image", image_url: item.image }],
      }];
    case "file":
      return [{
        type: "message",
        role: item.role,
        content: [{ type: "input_file", file_url: item.file }],
      }];
    case "reasoning":
      return [];
    case "function_call":
      return [{
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      }];
    case "function_call_output":
      return [{
        type: "function_call_output",
        call_id: item.call_id,
        output: item.output,
      }];
  }
}
