import { expect, test } from "bun:test";
import { type ProcessResult, ProcessRunner, type ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import { parseStartTokenOutput, probeHelperOwnerPid, startTokenCommand } from "../src/process-start-token.ts";

const MAC_TOKEN = "Mon Nov 16 10:23:45 2026";
const WINDOWS_TOKEN = "2026-11-16T16:23:45.1234567Z";

test.each([
  ["a macOS ps line", `${MAC_TOKEN}\n`, MAC_TOKEN],
  ["a Windows ISO line with CRLF", `${WINDOWS_TOKEN}\r\n`, WINDOWS_TOKEN],
] as const)("parses %s as a start token", (_name, output, expected) => {
  expect(parseStartTokenOutput(output)).toBe(expected);
});

test.each([
  ["empty output", ""],
  ["whitespace only", " \r\n\t"],
  ["two lines", `${MAC_TOKEN}\nTue Nov 17 11:01:02 2026\n`],
] as const)("rejects %s as a start token", (_name, output) => {
  expect(parseStartTokenOutput(output)).toBeUndefined();
});

test("builds the macOS token command from the validated pid", () => {
  expect(startTokenCommand("darwin", 4242)).toEqual({
    cmd: "ps",
    args: ["-o", "lstart=", "-p", "4242"],
    env: { LC_ALL: "C" },
  });
});

test("builds the Windows token command from the validated pid", () => {
  const command = startTokenCommand("win32", 4242);
  expect(command?.cmd).toBe("powershell");
  expect(command?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
  expect(command?.args[3]).toContain("Get-CimInstance Win32_Process");
  expect(command?.args[3]).toContain("ProcessId=4242");
  expect(command?.args[3]).toContain("CreationDate.ToUniversalTime().ToString('o')");
  expect(command?.env).toBeUndefined();
});

test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2] as const)(
  "builds no token command for pid %p",
  (pid) => {
    expect(startTokenCommand("darwin", pid)).toBeUndefined();
    expect(startTokenCommand("win32", pid)).toBeUndefined();
  },
);

test("has no argv token source for a platform that reads procfs directly", () => {
  expect(startTokenCommand("linux", 4242)).toBeUndefined();
});

type RunCall = {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

const runnerLayer = (
  respond: (options: ProcessSpawnOptions) => Effect.Effect<ProcessResult>,
  calls: RunCall[],
): Layer.Layer<ProcessRunner> =>
  Layer.succeed(
    ProcessRunner,
    ProcessRunner.of({
      run: (options) => {
        calls.push({
          cmd: options.cmd,
          args: options.args,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        return respond(options);
      },
      stream: () => Stream.empty,
      streamWithExit: () => Stream.empty,
    }),
  );

const withLiveProcess = async (body: (pid: number) => Promise<void>): Promise<void> => {
  const child = Bun.spawn(["cat"], { stdin: "pipe", stdout: "ignore" });
  try {
    await body(child.pid);
  } finally {
    child.kill();
    await child.exited;
  }
};

test("reads a macOS owner start token through the injected runner", async () => {
  await withLiveProcess(async (pid) => {
    const calls: RunCall[] = [];
    const observation = await Effect.runPromise(
      probeHelperOwnerPid(pid, "darwin").pipe(
        Effect.provide(
          runnerLayer(() => Effect.succeed({ exitCode: 0, stdout: `${MAC_TOKEN}\n`, stderr: "" }), calls),
        ),
      ),
    );
    expect(observation).toEqual({ state: "present", start: MAC_TOKEN });
    expect(calls).toEqual([
      { cmd: "ps", args: ["-o", "lstart=", "-p", String(pid)], env: { LC_ALL: "C" }, timeoutMs: 2_000 },
    ]);
  });
});

test("reads a Windows owner start token through the injected runner", async () => {
  await withLiveProcess(async (pid) => {
    const calls: RunCall[] = [];
    const observation = await Effect.runPromise(
      probeHelperOwnerPid(pid, "win32").pipe(
        Effect.provide(
          runnerLayer(
            () => Effect.succeed({ exitCode: 0, stdout: `${WINDOWS_TOKEN}\r\n`, stderr: "" }),
            calls,
          ),
        ),
      ),
    );
    expect(observation).toEqual({ state: "present", start: WINDOWS_TOKEN });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("powershell");
    expect(calls[0]?.args.join(" ")).toContain(`ProcessId=${pid}`);
    expect(calls[0]?.env).toBeUndefined();
  });
});

test.each([
  [
    "a nonzero exit",
    () => Effect.succeed({ exitCode: 1, stdout: `${MAC_TOKEN}\n`, stderr: "ps: no such process" }),
  ],
  ["empty output", () => Effect.succeed({ exitCode: 0, stdout: " \r\n", stderr: "" })],
  ["a runner failure", () => Effect.die("runner failure")],
] as const)("a token read with %s keeps the owner alive but unverifiable", async (_name, respond) => {
  await withLiveProcess(async (pid) => {
    const calls: RunCall[] = [];
    const observation = await Effect.runPromise(
      probeHelperOwnerPid(pid, "darwin").pipe(Effect.provide(runnerLayer(respond, calls))),
    );
    expect(observation).toEqual({ state: "present" });
    expect(calls).toHaveLength(1);
  });
});

test("a host platform without a runner keeps the owner alive but unverifiable", async () => {
  await withLiveProcess(async (pid) => {
    expect(await Effect.runPromise(probeHelperOwnerPid(pid, "darwin"))).toEqual({ state: "present" });
    expect(await Effect.runPromise(probeHelperOwnerPid(pid, "win32"))).toEqual({ state: "present" });
  });
});

test("an absent owner is reported without reading a token", async () => {
  const child = Bun.spawn(["cat"], { stdin: "pipe", stdout: "ignore" });
  child.kill();
  await child.exited;
  const calls: RunCall[] = [];
  const observation = await Effect.runPromise(
    probeHelperOwnerPid(child.pid, "win32").pipe(
      Effect.provide(runnerLayer(() => Effect.die("a dead pid must not be read"), calls)),
    ),
  );
  expect(observation).toEqual({ state: "absent" });
  expect(calls).toEqual([]);
});
