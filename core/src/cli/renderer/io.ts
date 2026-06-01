export interface RendererIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  /** `true` engages the interactive task-tree tail; `undefined`/`false` falls back to plain. */
  readonly isTTY?: boolean;
}

export const createStdioRendererIO = (
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): RendererIO => ({
  writeStdout: (chunk) => stdout.write(chunk),
  writeStderr: (chunk) => stderr.write(chunk),
  isTTY: stdout.isTTY === true,
});

export interface BufferedRendererIO extends RendererIO {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly stdoutLines: () => ReadonlyArray<string>;
  readonly stderrLines: () => ReadonlyArray<string>;
}

const splitLines = (text: string): ReadonlyArray<string> => {
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
};

export const createBufferedRendererIO = (): BufferedRendererIO => {
  let stdoutBuffer = "";
  let stderrBuffer = "";
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
  };
};
