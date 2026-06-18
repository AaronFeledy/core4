import type { RendererIO } from "@lando/sdk/renderer";

export type { RendererIO } from "@lando/sdk/renderer";

export const createStdioRendererIO = (
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
  stdin: NodeJS.ReadStream = process.stdin,
): RendererIO => ({
  writeStdout: (chunk) => stdout.write(chunk),
  writeStderr: (chunk) => stderr.write(chunk),
  isTTY: stdout.isTTY === true,
  get terminalColumns() {
    return typeof stdout.columns === "number" ? stdout.columns : undefined;
  },
  get terminalRows() {
    return typeof stdout.rows === "number" ? stdout.rows : undefined;
  },
  subscribeInput: (onKey) => {
    if (stdin.isTTY !== true) return () => {};
    const listener = (chunk: Buffer | string): void => onKey(chunk.toString("utf8"));
    const previousRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", listener);
    return () => {
      stdin.off("data", listener);
      stdin.setRawMode(previousRaw);
      stdin.pause();
    };
  },
});

export interface BufferedRendererIO extends RendererIO {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly stdoutLines: () => ReadonlyArray<string>;
  readonly stderrLines: () => ReadonlyArray<string>;
  readonly subscribeInput: (onKey: (raw: string) => void) => () => void;
  readonly injectKey: (raw: string) => void;
}

export interface BufferedRendererIOOptions {
  readonly isTTY?: boolean;
  readonly terminalColumns?: number | undefined;
  readonly terminalRows?: number | undefined;
}

const splitLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
};

export const createBufferedRendererIO = (options: BufferedRendererIOOptions = {}): BufferedRendererIO => {
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const listeners = new Set<(raw: string) => void>();
  return {
    writeStdout: (chunk) => {
      stdoutBuffer += chunk;
    },
    writeStderr: (chunk) => {
      stderrBuffer += chunk;
    },
    stdout: () => stdoutBuffer,
    stderr: () => stderrBuffer,
    stdoutLines: () => splitLines(stdoutBuffer),
    stderrLines: () => splitLines(stderrBuffer),
    ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
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
