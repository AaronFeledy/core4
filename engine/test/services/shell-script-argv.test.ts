import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createPayloadRedactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent, ProcessRunner } from "@lando/sdk/services";
import { Effect, Queue, Stream } from "effect";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";
import * as BunProcessRunner from "../../src/services/process-runner.ts";
import { streamArgvCommand } from "../../src/services/shell-script-stream.ts";

const execute = (argv: readonly string[], options: Parameters<typeof streamArgvCommand>[1] = {}) =>
  streamArgvCommand(argv, options, { tool: "argv-test", redaction: { substring: [] } }).pipe(
    Effect.provide(BunProcessRunner.layer),
  );

test("printf receives shell-looking argv bytes unchanged", async () => {
  const result = await Effect.runPromise(execute(["printf", "%s", "${X} $@ >&2"]));
  expect(result).toEqual({ exitCode: 0, stdout: "${X} $@ >&2", stderr: "" });
});

test("argv data bypasses shell parsing and forwards stdin with nonzero result data", async () => {
  const literal = "${X} $@ >&2";
  const result = await Effect.runPromise(
    execute(
      [
        process.execPath,
        "-e",
        'const input = await Bun.stdin.text(); process.stdout.write(process.argv[1] + input); process.stderr.write("diagnostic"); process.exitCode = 7;',
        literal,
      ],
      {
        stdinStream: {
          async *[Symbol.asyncIterator]() {
            yield new TextEncoder().encode("stdin-value");
          },
        },
      },
    ),
  );
  expect(result).toEqual({ exitCode: 7, stdout: `${literal}stdin-value`, stderr: "diagnostic" });
});

test.each([
  ["collected", 0],
  ["live", 0],
  ["collected", 7],
  ["live", 7],
] as const)("argv %s output and process events redact tooling values on exit %i", async (mode, exitCode) => {
  const secret = "tooling-argv-secret";
  const redaction = makeRedactionService();
  const payloads = {
    stdout: createPayloadRedactor(await Effect.runPromise(redaction.payloadValues())),
    stderr: createPayloadRedactor(await Effect.runPromise(redaction.payloadValues())),
  };
  const frames: StreamFrameSinkFrame[] = [];
  const events: LandoEvent[] = [];
  const run = streamArgvCommand(
    [
      process.execPath,
      "-e",
      `process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]); process.exitCode = ${exitCode};`,
      secret,
    ],
    {},
    { tool: "redaction", redaction: { substring: [secret] } },
  );
  const result = await Effect.runPromise(
    (mode === "live"
      ? run.pipe(
          Effect.provideService(StreamFrameSink, {
            emit: (frame) =>
              Effect.sync(() => {
                const bytes =
                  typeof frame.chunk === "string" ? new TextEncoder().encode(frame.chunk) : frame.chunk;
                frames.push({ ...frame, kind: "bytes", chunk: payloads[frame._tag].write(bytes) });
              }),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              for (const tag of ["stdout", "stderr"] as const)
                frames.push({ kind: "bytes", _tag: tag, chunk: payloads[tag].flush() });
            }),
          ),
        )
      : run
    ).pipe(
      Effect.provide(BunProcessRunner.layer),
      Effect.provideService(RedactionService, redaction),
      Effect.provideService(
        EventService,
        EventService.of({
          publish: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          subscribe: () => Stream.empty,
          subscribeQueue: Queue.unbounded<never>(),
          waitFor: () => Effect.never,
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.never,
          query: () => Effect.succeed([]),
        }),
      ),
    ),
  );
  expect(result).toEqual({
    exitCode,
    stdout: mode === "live" ? "" : "[redacted]",
    stderr: mode === "live" ? "" : "[redacted]",
  });
  if (mode === "live") {
    for (const tag of ["stdout", "stderr"] as const)
      expect(
        frames
          .filter((frame) => frame._tag === tag)
          .map((frame) =>
            typeof frame.chunk === "string" ? frame.chunk : new TextDecoder().decode(frame.chunk),
          )
          .join(""),
      ).toBe("[redacted]");
  }
  expect(events.map((event) => event._tag)).toEqual(["pre-process-exec", "post-process-exec"]);
  expect(JSON.stringify(events)).not.toContain(secret);
});

test("argv cancellation aborts the running process after its ready frame", async () => {
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  let stdout = "";
  const run = execute(
    [
      process.execPath,
      "-e",
      'Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") }); process.stdout.write("ready");',
    ],
    { signal: controller.signal },
  ).pipe(
    Effect.provideService(StreamFrameSink, {
      emit: (frame) =>
        Effect.sync(() => {
          if (frame._tag !== "stdout") return;
          stdout += typeof frame.chunk === "string" ? frame.chunk : new TextDecoder().decode(frame.chunk);
          if (stdout === "ready") ready.resolve();
        }),
    }),
  );
  const completion = Effect.runPromise(Effect.result(run));
  try {
    await Effect.runPromise(Effect.promise(() => ready.promise).pipe(Effect.timeout("3 seconds")));
    controller.abort(new Error("argv-test-cancelled"));
    const result = await Effect.runPromise(
      Effect.promise(() => completion).pipe(Effect.timeout("3 seconds")),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ToolingExecError",
        message: expect.stringContaining("argv-test-cancelled"),
      },
    });
  } finally {
    controller.abort();
  }
});

test.each([[[]], [[""]]] as const)("empty argv %j refuses before spawning", async (argv) => {
  const forbidden = () => Effect.die("Must not spawn empty argv");
  const result = await Effect.runPromise(
    streamArgvCommand(argv, {}, { tool: "empty", redaction: { substring: [] } }).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({
          run: forbidden,
          stream: () => Stream.die("Must not spawn"),
          streamWithExit: () => Stream.die("Must not spawn"),
        }),
      ),
      Effect.flip,
    ),
  );
  expect(result._tag).toBe("ToolingExecError");
  expect(result.remediation).toBe("Set the first argv element to the host executable to run.");
});

test("argv spawn failures carry ToolingExecError remediation", async () => {
  const result = await Effect.runPromise(
    execute(["lando-missing-executable-for-argv-test"]).pipe(Effect.flip),
  );
  expect(result._tag).toBe("ToolingExecError");
  expect(result.remediation).toBe(
    "Install the missing host executable or fix its path, then re-run the command.",
  );
});
