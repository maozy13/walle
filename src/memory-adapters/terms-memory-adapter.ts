import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type {
  MemoryAdapter,
  MemoryOperation,
} from "../typings/memory.js";

/** Stable selector name used by both operations of the terminology memory. */
export const TERMS_MEMORY_NAME = "terms_memory";

/** Default path, relative to the configured working directory, for terminology memory. */
export const TERMS_MEMORY_PATH = "memories/TERMS.md";

/** Description used when the primary Agent decides whether to retrieve terminology. */
export const TERMS_RETRIEVE_DESCRIPTION =
  "术语记忆。当用户输入的任务中存在尚未明确的缩写或专有名词术语时进行召回。";

/** Description used when the memory Agent decides whether and how to update terminology. */
export const TERMS_UPDATE_DESCRIPTION =
  "术语记忆。更新记忆任务上下文中存在用户解释过的术语或用户做出选择的多义词时更新记忆，content 必须是符合 {term, definition} Schema 的 JSON 字符串，其中 term 和 definition 均为非空字符串。";

/** Runtime-validated content accepted by the terminology update operation. */
const termUpdateSchema = z.object({
  term: z.string().trim().min(1),
  definition: z.string().trim().min(1),
}).strict();

/** Runtime-validated metadata persisted beside each terminology entry. */
const termMetadataSchema = z.object({
  created_at: z.number().finite(),
}).passthrough();

/** One parsed entry in the Markdown terminology store. */
interface TermEntry {
  /** Original display spelling of the term. */
  term: string;
  /** Persisted definition text. */
  definition: string;
  /** Metadata preserved when an existing definition is replaced. */
  metadata: z.output<typeof termMetadataSchema>;
}

/** File-backed memory adapter for terminology learned during Agent tasks. */
export class TermsMemoryAdapter implements MemoryAdapter {
  public readonly retrieve: MemoryOperation<string, Record<string, string>>;
  public readonly update: MemoryOperation<string, { term: string; definition: string }>;
  public readonly path: string;

  /**
   * Creates a terminology adapter rooted at a working directory.
   * @param cwd Working directory containing the memories directory.
   */
  public constructor(cwd: string = process.cwd()) {
    this.path = resolve(cwd, TERMS_MEMORY_PATH);
    this.retrieve = operation(
      TERMS_MEMORY_NAME,
      TERMS_RETRIEVE_DESCRIPTION,
      (query) => this.retrieveTerms(query),
    );
    this.update = operation(
      TERMS_MEMORY_NAME,
      TERMS_UPDATE_DESCRIPTION,
      (content) => this.updateTerm(content),
    );
  }

  /**
   * Retrieves definitions whose terms completely match one of the query keywords.
   * @param query One term, a delimited term list, or a JSON string array.
   * @returns Object mapping stored term spellings to their definitions.
   */
  private retrieveTerms(query: string): Record<string, string> {
    const keywords = queryKeywords(query);
    const result: Record<string, string> = {};
    for (const entry of this.read()) {
      if (keywords.has(normalizeTerm(entry.term))) {
        result[entry.term] = entry.definition;
      }
    }
    return result;
  }

  /**
   * Adds a terminology entry or replaces its definition using case-insensitive identity.
   * @param content JSON string containing a term and its definition.
   * @returns The normalized term and definition written to disk.
   */
  private updateTerm(content: string): { term: string; definition: string } {
    const update = parseUpdate(content);
    const entries = this.read();
    const normalized = normalizeTerm(update.term);
    const existing = entries.find((entry) => normalizeTerm(entry.term) === normalized);
    if (existing === undefined) {
      entries.push({
        ...update,
        metadata: { created_at: Date.now() },
      });
    } else {
      existing.definition = update.definition;
    }
    this.write(entries);
    return update;
  }

  /**
   * Reads and parses all terminology entries, treating a missing file as empty memory.
   * @returns Terminology entries in storage order.
   */
  private read(): TermEntry[] {
    let markdown: string;
    try {
      markdown = readFileSync(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    return parseTerms(markdown);
  }

  /**
   * Persists the complete terminology collection in the specified Markdown format.
   * @param entries Terminology entries to write in order.
   */
  private write(entries: TermEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, serializeTerms(entries), "utf8");
  }
}

/**
 * Attaches model-selection metadata to a memory operation.
 * @template TInput Operation input type.
 * @template TResult Operation result type.
 * @param name Stable adapter selector name.
 * @param description Model-facing selection guidance.
 * @param callback Operation implementation.
 * @returns Callable operation with immutable metadata.
 */
function operation<TInput, TResult>(
  name: string,
  description: string,
  callback: (input: TInput) => TResult | Promise<TResult>,
): MemoryOperation<TInput, TResult> {
  Object.defineProperty(callback, "name", { value: name });
  return Object.assign(callback, { description });
}

/**
 * Parses the flexible string representation accepted by terminology retrieval.
 * @param query Model-generated term query.
 * @returns Normalized exact-match keywords.
 */
function queryKeywords(query: string): Set<string> {
  const trimmed = query.trim();
  if (trimmed === "") return new Set();
  try {
    const decoded: unknown = JSON.parse(trimmed);
    if (typeof decoded === "string") return new Set([normalizeTerm(decoded)]);
    if (Array.isArray(decoded) && decoded.every((value) => typeof value === "string")) {
      return new Set(decoded.map(normalizeTerm).filter((value) => value !== ""));
    }
  } catch {
    // Plain queries are expected and are handled below.
  }
  const keywords = trimmed.split(/[,，;；\n\r\t]+/u);
  if (keywords.length === 1) {
    keywords.push(...trimmed.split(/\s+/u));
  }
  return new Set(keywords.map(normalizeTerm).filter((value) => value !== ""));
}

/**
 * Parses and validates JSON update content.
 * @param content JSON string produced by the memory update Agent.
 * @returns Trimmed terminology update.
 */
function parseUpdate(content: string): z.output<typeof termUpdateSchema> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error("Terms memory content must be valid JSON", { cause: error });
  }
  return termUpdateSchema.parse(value);
}

/**
 * Parses the Markdown terminology storage format.
 * @param markdown Complete TERMS.md content.
 * @returns Validated terminology entries.
 */
function parseTerms(markdown: string): TermEntry[] {
  if (markdown.trim() === "") return [];
  return markdown.trim().split(/\r?\n---\r?\n/u).map((block, index) => {
    const lines = block.split(/\r?\n/u);
    if (lines.length < 3) throw invalidEntry(index);
    const term = lines[0]?.trim() ?? "";
    const definition = lines.slice(1, -1).join("\n").trim();
    const metadataText = lines.at(-1)?.trim() ?? "";
    if (term === "" || definition === "") throw invalidEntry(index);
    let metadata: unknown;
    try {
      metadata = JSON.parse(metadataText);
    } catch (error) {
      throw new Error(`Invalid terms memory entry ${index + 1}: malformed metadata`, {
        cause: error,
      });
    }
    return { term, definition, metadata: termMetadataSchema.parse(metadata) };
  });
}

/**
 * Serializes terminology entries with thematic-rule separators.
 * @param entries Entries in stable storage order.
 * @returns Markdown content ending in one newline, or an empty string.
 */
function serializeTerms(entries: TermEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => [
    entry.term,
    entry.definition,
    JSON.stringify(entry.metadata),
  ].join("\n")).join("\n---\n")}\n`;
}

/**
 * Normalizes a term for case-insensitive exact comparison.
 * @param term Term spelling to normalize.
 * @returns Trimmed lower-case term.
 */
function normalizeTerm(term: string): string {
  return term.trim().toLocaleLowerCase();
}

/**
 * Creates a consistent structural error for one malformed Markdown entry.
 * @param index Zero-based entry index.
 * @returns Error identifying the malformed entry.
 */
function invalidEntry(index: number): Error {
  return new Error(`Invalid terms memory entry ${index + 1}: unsupported entry shape`);
}

/**
 * Checks whether an unknown thrown value exposes a Node.js error code.
 * @param error Thrown value to inspect.
 * @returns Whether the value is a NodeJS.ErrnoException.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
