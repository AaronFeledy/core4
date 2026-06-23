/**
 * Prompt I/O abstraction for the recipe prompt runtime.
 *
 * The runtime is decoupled from `process.stdin`/`process.stdout` so
 * unit tests can supply scripted input streams and capture transcripts
 * byte-for-byte. Production code uses {@link createStdioPromptIO}.
 */

import { ReadStream } from "node:tty";

import { PromptCancelledError } from "./driver.ts";

/** Captured write stream payload. Either a string or a raw byte buffer. */
export type PromptIOWriteChunk = string;

// Reject a pending read with PromptCancelledError when `signal` aborts, so the
// caller's `finally` (raw-mode restore) runs; the underlying read is abandoned
// (JS reads cannot be force-cancelled). The abort listener is always removed.
const raceAbort = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (signal === undefined) return promise;
  if (signal.aborted) throw new PromptCancelledError("Prompt aborted.");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new PromptCancelledError("Prompt aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
};

/** Reader options applied per `readLine` invocation. */
export interface PromptReadOptions {
  /**
   * When true, the implementation MUST NOT echo input back to the
   * transcript (or any visible surface) and MUST NOT include the
   * returned value in any user-visible log, error, or message.
   * Used for `secret` prompts.
   */
  readonly secret?: boolean;
}

/** Pluggable prompt I/O surface. */
export interface PromptIO {
  /** Read a single line of input (newline-stripped). */
  readonly readLine: (options?: PromptReadOptions) => Promise<string>;
  /** Write to the user-visible prompt transcript (stdout-equivalent). */
  readonly write: (chunk: PromptIOWriteChunk) => void;
  /** Write to the diagnostic surface (stderr-equivalent) — validation messages, banners. */
  readonly writeError: (chunk: PromptIOWriteChunk) => void;
  /** True when the user-facing transcript is a real terminal. */
  readonly isTTY: boolean;
}

/**
 * A line-buffered reader over a Node Readable.
 *
 * Buffers chunks across calls so consecutive `readLine` invocations
 * receive consecutive lines from the same upstream stream.
 */
/**
 * Line-buffered reader over a Node Readable that survives across `readLine`
 * calls. A single instance must be reused by every prompt batch reading the same
 * stream so input buffered ahead of a newline is never stranded between batches.
 */
export interface PromptLineReader {
  readonly readLine: (signal?: AbortSignal) => Promise<string>;
}

export const createLineReader = (stream: NodeJS.ReadableStream): PromptLineReader => {
  let buffer = "";
  let done = false;
  let iterator: AsyncIterator<Buffer | string> | undefined;
  // A read abandoned by `raceAbort` leaves its `iterator.next()` unsettled; reuse
  // that pending promise on the next read so input is never dropped or reordered.
  let pendingNext: Promise<IteratorResult<Buffer | string>> | undefined;

  const readLine = async (signal?: AbortSignal): Promise<string> => {
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        // Strip trailing CR for CRLF input.
        return line.endsWith("\r") ? line.slice(0, -1) : line;
      }
      if (done) {
        const tail = buffer;
        buffer = "";
        return tail;
      }
      iterator ??= stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
      pendingNext ??= iterator.next() as Promise<IteratorResult<Buffer | string>>;
      const result = await raceAbort(pendingNext, signal);
      pendingNext = undefined;
      const { value, done: streamDone } = result;
      if (streamDone) {
        done = true;
        continue;
      }
      buffer += typeof value === "string" ? value : value.toString("utf8");
    }
  };

  return { readLine };
};

interface StdioPromptIOOptions {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  /** Aborting this signal rejects an in-flight `readLine` with `PromptCancelledError`. */
  readonly signal?: AbortSignal;
  /** Reuse a persistent reader across batches so buffered input survives between calls. */
  readonly lineReader?: PromptLineReader;
}

/**
 * Build a `PromptIO` backed by the host's stdin/stdout/stderr (or the
 * provided streams). Secret reads do NOT echo characters: input is read
 * silently regardless of whether the upstream is a TTY.
 */
export const createStdioPromptIO = (options: StdioPromptIOOptions = {}): PromptIO => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const signal = options.signal;
  const reader = options.lineReader ?? createLineReader(stdin);
  const isTTY = stdin instanceof ReadStream && stdin.isTTY === true;

  const readLine = async (readOptions?: PromptReadOptions): Promise<string> => {
    const secret = readOptions?.secret === true;
    if (!secret) {
      return reader.readLine(signal);
    }
    if (isTTY && stdin instanceof ReadStream) {
      const wasRaw = stdin.isRaw;
      try {
        stdin.setRawMode(true);
        return await readRawLineSilently(stdin, signal);
      } finally {
        stdin.setRawMode(wasRaw);
      }
    }
    return reader.readLine(signal);
  };

  return {
    readLine,
    write: (chunk) => {
      stdout.write(chunk);
    },
    writeError: (chunk) => {
      stderr.write(chunk);
    },
    isTTY,
  };
};

/**
 * Read a single line from a raw-mode TTY without echoing characters
 * back to the terminal. Returns the entered line on `\n` or `\r`.
 * Handles backspace (0x7f / 0x08) by trimming the buffer.
 */
const readRawLineSilently = async (stdin: ReadStream, signal?: AbortSignal): Promise<string> => {
  let line = "";
  const iterator = (stdin as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  while (true) {
    const { value: chunk, done } = await raceAbort(iterator.next(), signal);
    if (done) return line;
    const text = chunk.toString("utf8");
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (ch === "\n" || ch === "\r") {
        return line;
      }
      if (code === 0x7f || code === 0x08) {
        line = line.slice(0, -1);
        continue;
      }
      if (code === 0x03) {
        // Ctrl-C: cancel the prompt; the caller maps this to InteractionCancelledError.
        throw new PromptCancelledError("Prompt cancelled by user (Ctrl-C).");
      }
      line += ch;
    }
  }
};

/** A `PromptIO` implementation that pulls scripted answers from memory. */
export interface BufferedPromptIO extends PromptIO {
  /** Read everything written to the stdout-equivalent surface. */
  readonly stdout: () => string;
  /** Read everything written to the stderr-equivalent surface. */
  readonly stderr: () => string;
}

/**
 * Build a `PromptIO` for tests. `inputs` is consumed line-by-line: each
 * call to `readLine` returns the next entry. Running out of scripted
 * lines throws — tests should provide exactly as many answers as the
 * runtime will read (including answers for re-prompt loops).
 */
export const createBufferedPromptIO = (options: {
  readonly inputs: ReadonlyArray<string>;
  readonly isTTY?: boolean;
}): BufferedPromptIO => {
  let cursor = 0;
  const stdoutBuffer: string[] = [];
  const stderrBuffer: string[] = [];

  return {
    isTTY: options.isTTY ?? false,
    readLine: async (_readOptions?: PromptReadOptions) => {
      if (cursor >= options.inputs.length) {
        throw new Error(`BufferedPromptIO ran out of scripted inputs after ${cursor.toString()} reads.`);
      }
      const answer = options.inputs[cursor];
      cursor += 1;
      return answer as string;
    },
    write: (chunk) => {
      stdoutBuffer.push(chunk);
    },
    writeError: (chunk) => {
      stderrBuffer.push(chunk);
    },
    stdout: () => stdoutBuffer.join(""),
    stderr: () => stderrBuffer.join(""),
  };
};
