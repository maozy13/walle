import type { InputItem } from "neuralink";

/** Role of user-visible text, image, and file conversation items. */
export type ConversationRole = "user" | "assistant";

/** Text stored in a conversation. */
export interface TextConversationItem {
  /** Stable item discriminator. */
  type: "text";
  /** Item producer. */
  role: ConversationRole;
  /** Plain text content. */
  text: string;
}

/** Image stored in a conversation. */
export interface ImageConversationItem {
  /** Stable item discriminator. */
  type: "image";
  /** Item producer. */
  role: ConversationRole;
  /** Image URI. */
  image: string;
}

/** File stored in a conversation. */
export interface FileConversationItem {
  /** Stable item discriminator. */
  type: "file";
  /** Item producer. */
  role: ConversationRole;
  /** File URI. */
  file: string;
}

/** Model reasoning stored for inspection but not replayed to NeuralLink. */
export interface ReasoningConversationItem {
  /** Stable item discriminator. */
  type: "reasoning";
  /** Item producer. */
  role: "assistant";
  /** Reasoning body. */
  content: string;
  /** Reasoning summary. */
  summary: string;
}

/** Function call selected by the model. */
export interface FunctionCallConversationItem {
  /** Stable item discriminator. */
  type: "function_call";
  /** Item producer. */
  role: "assistant";
  /** Function-call identifier. */
  call_id: string;
  /** Registered function name. */
  name: string;
  /** JSON-encoded arguments. */
  arguments: string;
}

/** Result returned by a local tool. */
export interface FunctionCallOutputConversationItem {
  /** Stable item discriminator. */
  type: "function_call_output";
  /** Item producer. */
  role: "tool";
  /** Associated function-call identifier. */
  call_id: string;
  /** Serialized tool result. */
  output: string;
}

/** Any item retained by a WallE conversation. */
export type ConversationItem =
  | TextConversationItem
  | ImageConversationItem
  | FileConversationItem
  | ReasoningConversationItem
  | FunctionCallConversationItem
  | FunctionCallOutputConversationItem;

/** NeuralLink-compatible representation returned by a conversation. */
export type ConversationInput = InputItem[];
