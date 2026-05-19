/**
 * Prompt I/O abstraction for the recipe prompt runtime.
 *
 * The runtime is decoupled from `process.stdin`/`process.stdout` so
 * unit tests can supply scripted input streams and capture transcripts
 * byte-for-byte. Production code uses {@link createStdioPromptIO}.
 */

import { ReadStream } from "node:tty";

/** Captured write stream payload. Either a string or a raw byte buffer. */
export type PromptIOWriteChunk = string;

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
const createLineReader = (stream: NodeJS.ReadableStream) => {
  let buffer = "";
  let done = false;
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;

  const readLine = async (): Promise<string> => {
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
      const { value, done: streamDone } = await iterator.next();
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
  const reader = createLineReader(stdin);
  const isTTY = stdin instanceof ReadStream && stdin.isTTY === true;

  const readLine = async (readOptions?: PromptReadOptions): Promise<string> => {
    const secret = readOptions?.secret === true;
    if (!secret) {
      return reader.readLine();
    }
    if (isTTY && stdin instanceof ReadStream) {
      const wasRaw = stdin.isRaw;
      try {
        stdin.setRawMode(true);
        return await readRawLineSilently(stdin);
      } finally {
        stdin.setRawMode(wasRaw);
      }
    }
    return reader.readLine();
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
const readRawLineSilently = async (stdin: ReadStream): Promise<string> => {
  let line = "";
  for await (const chunk of stdin as AsyncIterable<Buffer>) {
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
        // Ctrl-C: abort the prompt by throwing a recognizable error
        // up the stack. The caller maps this to a cancellation.
        throw new Error("Prompt cancelled by user (Ctrl-C).");
      }
      line += ch;
    }
  }
  return line;
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
