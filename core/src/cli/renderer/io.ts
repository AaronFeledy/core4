export interface RendererIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
}

export const createStdioRendererIO = (
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): RendererIO => ({
  writeStdout: (chunk) => {
    stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    stderr.write(chunk);
  },
});

export interface BufferedRendererIO extends RendererIO {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly stdoutLines: () => ReadonlyArray<string>;
  readonly stderrLines: () => ReadonlyArray<string>;
}

const splitLines = (text: string): ReadonlyArray<string> =>
  text.length === 0
    ? []
    : text.split("\n").filter((line, index, all) => !(index === all.length - 1 && line === ""));

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
