import type { RendererIO } from "./io.ts";

export interface BufferedRendererIO extends RendererIO {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly stdoutBytes: () => Uint8Array;
  readonly stderrBytes: () => Uint8Array;
  readonly stdoutLines: () => ReadonlyArray<string>;
  readonly stderrLines: () => ReadonlyArray<string>;
  readonly subscribeInput: (onKey: (raw: string) => void) => () => void;
  readonly injectKey: (raw: string) => void;
}

export interface BufferedRendererIOOptions {
  readonly stdoutIsTTY?: boolean;
  readonly stdoutColumns?: number | undefined;
  readonly isTTY?: boolean;
  readonly terminalColumns?: number | undefined;
  readonly terminalRows?: number | undefined;
}

const splitLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
};

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const createBufferedRendererIO = (options: BufferedRendererIOOptions = {}): BufferedRendererIO => {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const listeners = new Set<(raw: string) => void>();
  return {
    writeStdout: (chunk) => {
      stdoutChunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    },
    writeStderr: (chunk) => {
      stderrChunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    },
    stdout: () => new TextDecoder().decode(concatBytes(stdoutChunks)),
    stderr: () => new TextDecoder().decode(concatBytes(stderrChunks)),
    stdoutBytes: () => concatBytes(stdoutChunks),
    stderrBytes: () => concatBytes(stderrChunks),
    stdoutLines: () => splitLines(new TextDecoder().decode(concatBytes(stdoutChunks))),
    stderrLines: () => splitLines(new TextDecoder().decode(concatBytes(stderrChunks))),
    ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
    ...(options.stdoutIsTTY === undefined ? {} : { stdoutIsTTY: options.stdoutIsTTY }),
    stdoutColumns: options.stdoutColumns,
    terminalColumns: options.terminalColumns,
    terminalRows: options.terminalRows,
    subscribeInput: (onKey) => {
      listeners.add(onKey);
      return () => {
        listeners.delete(onKey);
      };
    },
    injectKey: (raw) => {
      for (const listener of [...listeners]) listener(raw);
    },
  };
};
