/**
 * A callable memory operation carrying the metadata used to select an adapter.
 * @template TInput Value forwarded by the Memory dispatcher.
 * @template TResult Value returned by the adapter operation.
 */
export type MemoryOperation<TInput, TResult = unknown> = ((
  /** Model-generated value forwarded without interpretation by the adapter registry. */
  input: TInput,
) => TResult | Promise<TResult>) & {
  /** Stable adapter name used by Memory for routing. */
  readonly name: string;
  /** Model-facing guidance describing when and how to use the operation. */
  readonly description: string;
};

/** A pluggable source that retrieves and updates one kind of Agent memory. */
export interface MemoryAdapter {
  /** Model-selectable operation for retrieving relevant memory. */
  readonly retrieve: MemoryOperation<string>;
  /** Model-selectable operation for persisting JSON-encoded memory content. */
  readonly update: MemoryOperation<string>;
}

/** Arguments accepted by the built-in memory retrieval tool. */
export interface MemoryRetrieveArguments {
  /** Registered memory source name. */
  name: string;
  /** Search expression forwarded to the selected adapter. */
  query: string;
}

/** Arguments accepted by the built-in memory update tool. */
export interface MemoryUpdateArguments {
  /** Registered memory source name. */
  name: string;
  /** JSON-encoded update content forwarded to the selected adapter. */
  content: string;
}
