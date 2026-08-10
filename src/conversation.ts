import type {
  InputItem,
  ResponseOutputItem,
} from "neuralink";
import type {
  ConversationInput,
  ConversationItem,
} from "./typings/conversation.js";

/** Ordered multi-turn context owned by a WallE agent. */
export class Conversation {
  public readonly items: ConversationItem[];

  /**
   * Creates a conversation with optional existing items.
   * @param items Initial conversation items in chronological order.
   */
  public constructor(items: ConversationItem[] = []) {
    this.items = [...items];
  }

  /**
   * Converts the retained conversation to NeuralLink model input.
   * @returns A detached NeuralLink-compatible input array.
   */
  public read(): ConversationInput {
    return this.items.flatMap(toInputItem);
  }

  /**
   * Appends items and returns the complete NeuralLink-compatible conversation.
   * @param items Conversation items to append in chronological order.
   * @returns A detached NeuralLink-compatible input array.
   */
  public append(items: ConversationItem[]): ConversationInput {
    this.items.push(...items);
    return this.read();
  }
}

/**
 * Normalizes user-supplied NeuralLink input into conversation items.
 * @param input Plain text or structured NeuralLink input.
 * @returns Normalized conversation items.
 */
export function fromUserInput(input: string | InputItem[]): ConversationItem[] {
  if (typeof input === "string") {
    return [{ type: "text", role: "user", text: input }];
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
      return {
        type: "function_call",
        role: "assistant",
        call_id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      };
    }
    if (item.type === "reasoning") {
      return {
        type: "reasoning",
        role: "assistant",
        content: item.content.text,
        summary: item.summary.text,
      };
    }
    return {
      type: "text",
      role: "assistant",
      text: item.content.type === "output_text"
        ? item.content.text
        : item.content.refusal,
    };
  });
}

/**
 * Converts NeuralLink input into retained conversation items.
 * @param item NeuralLink input item.
 * @returns Normalized conversation items in content-block order.
 */
function fromInputItem(item: InputItem): ConversationItem[] {
  if (item.type === "function_call") {
    return [{ ...item, role: "assistant" }];
  }
  if (item.type === "function_call_output") {
    return [{ ...item, role: "tool" }];
  }
  const role = item.role === "assistant" ? "assistant" : "user";
  return item.content.map((content): ConversationItem => {
    if (content.type === "input_image") {
      return { type: "image", role, image: content.image_url };
    }
    if (content.type === "input_file") {
      return { type: "file", role, file: content.file_url };
    }
    return { type: "text", role, text: content.text };
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
