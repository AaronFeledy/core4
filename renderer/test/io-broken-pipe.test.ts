import { expect, mock, test } from "bun:test";
import { Socket } from "node:net";

// Each scenario owns a module instance: destination notifications are process-lifetime state.
let scenario = 0;
const freshIO = async (): Promise<typeof import("../src/io.ts")> =>
  import(`../src/io.ts?broken-pipe=${scenario++}`);
const brokenPipe = () =>
  Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE", syscall: "write" });
const fakeStream = (failure?: Error) => {
  const chunks: string[] = [];
  const write = mock((chunk: string) => {
    if (failure) throw failure;
    chunks.push(chunk);
    return true;
  });
  const stream = Object.assign(new Socket(), {
    write,
    isTTY: false,
    columns: 80,
    rows: 24,
    clearLine: () => true,
    clearScreenDown: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
    getWindowSize: (): [number, number] => [80, 24],
    getColorDepth: () => 1,
    hasColors: () => false,
  });
  return { stream, write, chunks };
};

test("silences subsequent writes when stdout throws EPIPE synchronously", async () => {
  // Given
  const { createStdioRendererIO } = await freshIO();
  const stdout = fakeStream(brokenPipe());
  const io = createStdioRendererIO(stdout.stream, fakeStream().stream);
  // When / Then
  expect(() => io.writeStdout("x")).not.toThrow();
  expect<unknown>(io.writeStdout("again")).toBe(false);
  expect(stdout.write).toHaveBeenCalledTimes(1);
});

test("attaches one listener and stops writes when an asynchronous pipe error arrives", async () => {
  // Given
  const { createStdioRendererIO } = await freshIO();
  const stdout = fakeStream();
  const io = createStdioRendererIO(stdout.stream, fakeStream().stream);
  io.writeStdout("first");
  createStdioRendererIO(stdout.stream).writeStdout("second");
  // When / Then
  expect(stdout.stream.listenerCount("error")).toBe(1);
  expect(() => stdout.stream.emit("error", brokenPipe())).not.toThrow();
  expect<unknown>(io.writeStdout("ignored")).toBe(false);
  expect(stdout.chunks).toEqual(["first", "second"]);
});

test.each(["stdout", "stderr"] as const)(
  "keeps the other stream writable when %s breaks",
  async (destination) => {
    // Given
    const { createStdioRendererIO } = await freshIO();
    const broken = fakeStream(brokenPipe());
    const healthy = fakeStream();
    const io =
      destination === "stdout"
        ? createStdioRendererIO(broken.stream, healthy.stream)
        : createStdioRendererIO(healthy.stream, broken.stream);
    // When
    expect(() => {
      const writeBroken = destination === "stdout" ? io.writeStdout : io.writeStderr;
      const writeHealthy = destination === "stdout" ? io.writeStderr : io.writeStdout;
      writeBroken("x");
      writeHealthy("y");
    }).not.toThrow();
    // Then
    expect(healthy.chunks).toEqual(["y"]);
  },
);

test("notifies once per destination and stops notifying when unsubscribed", async () => {
  // Given
  const { createStdioRendererIO, onStdioBrokenPipe } = await freshIO();
  const listener = mock((_destination: "stdout" | "stderr") => {});
  const unsubscribe = onStdioBrokenPipe(listener);
  try {
    // When
    createStdioRendererIO(fakeStream(brokenPipe()).stream).writeStdout("x");
    createStdioRendererIO(fakeStream(brokenPipe()).stream).writeStdout("again");
    unsubscribe();
    createStdioRendererIO(fakeStream().stream, fakeStream(brokenPipe()).stream).writeStderr("y");
    // Then
    expect(listener.mock.calls).toEqual([["stdout"]]);
  } finally {
    unsubscribe();
  }
});

test("guards line writes when an injected stream has no event capability", async () => {
  // Given
  const { writeStdioLine } = await freshIO();
  const stream = {
    write: mock((_chunk: string): boolean => {
      throw brokenPipe();
    }),
  };
  // When / Then
  expect(() => writeStdioLine("stdout", "hello", stream)).not.toThrow();
  expect(() => writeStdioLine("stdout", "again", stream)).not.toThrow();
  expect(stream.write.mock.calls).toEqual([["hello\n"]]);
});

test("restores sticky status at exit when a later failure overwrites it", async () => {
  // Given
  const { createStdioRendererIO, installBrokenPipeExitPolicy, BROKEN_PIPE_EXIT_CODE } = await freshIO();
  const exits: (() => void)[] = [];
  const proc = {
    exitCode: 0,
    once: mock((_event: "exit", listener: () => void) => {
      exits.push(listener);
    }),
  };
  const uninstall = installBrokenPipeExitPolicy(proc);
  try {
    expect(installBrokenPipeExitPolicy(proc)).toBe(uninstall);
    expect(proc.once).not.toHaveBeenCalled();
    // When
    createStdioRendererIO(fakeStream(brokenPipe()).stream).writeStdout("x");
    // Then
    expect(BROKEN_PIPE_EXIT_CODE).toBe(141);
    expect(proc.exitCode).toBe(141);
    proc.exitCode = 1;
    for (const exit of exits) exit();
    expect(proc.exitCode).toBe(141);
    createStdioRendererIO(fakeStream().stream, fakeStream(brokenPipe()).stream).writeStderr("y");
    expect(proc.once).toHaveBeenCalledTimes(1);
  } finally {
    uninstall();
  }
});

test("leaves exit status alone when the policy is uninstalled before a pipe breaks", async () => {
  // Given
  const { createStdioRendererIO, installBrokenPipeExitPolicy } = await freshIO();
  const proc = { exitCode: 7, once: mock((_event: "exit", _listener: () => void) => {}) };
  const uninstall = installBrokenPipeExitPolicy(proc);
  uninstall();
  // When
  createStdioRendererIO(fakeStream(brokenPipe()).stream).writeStdout("x");
  // Then
  expect(proc.exitCode).toBe(7);
  expect(proc.once).not.toHaveBeenCalled();
});

test("recognizes only broken-pipe codes or message prefixes when given unknown errors", async () => {
  // Given
  const { isBrokenPipeError } = await freshIO();
  const errors = [
    { code: "EPIPE" },
    { code: "EOF" },
    new Error("EPIPE: closed"),
    { code: "ENOENT" },
    undefined,
    "string",
    null,
  ];
  // When / Then
  expect(errors.map(isBrokenPipeError)).toEqual([true, true, true, false, false, false, false]);
});

test("rethrows the original error when a write fails for another reason", async () => {
  // Given
  const { createStdioRendererIO } = await freshIO();
  const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const stdout = fakeStream(failure);
  const io = createStdioRendererIO(stdout.stream);
  // When / Then
  expect(() => io.writeStdout("x")).toThrow(failure);
  expect(() => io.writeStdout("again")).toThrow(failure);
  expect(stdout.write).toHaveBeenCalledTimes(2);
});
