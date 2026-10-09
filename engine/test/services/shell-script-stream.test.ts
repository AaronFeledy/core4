import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent, ShellRunner } from "@lando/sdk/services";
import { Effect, Layer, Queue, Stream } from "effect";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";
import * as BunShellRunner from "../../src/services/shell-runner.ts";

test.each(["collected", "live"] as const)(
  "preserves script inputs and both output streams with restricted PATH in %s mode",
  async (mode) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-shell-runtime-"));
    const frames: StreamFrameSinkFrame[] = [];
    const shellLayer = BunShellRunner.layer(() => {
      throw new TypeError("unused interactive IO");
    });
    try {
      const script = join(root, "probe.bun.sh");
      await writeFile(
        script,
        'echo "$FOO"; echo "<$1>"; echo "<$2>"; echo "<$3>"; pwd; echo diagnostic 1>&2; echo -n tail\n',
      );
      const run = Effect.flatMap(ShellRunner, (shell) =>
        shell.runScript(script, {
          cwd: root,
          env: { PATH: root, FOO: "explicit-env" },
          argv: ["two words", "", "$(echo injected)"],
        }),
      ).pipe(Effect.provide(shellLayer));
      // When
      const result = await Effect.runPromise(
        mode === "collected"
          ? run
          : run.pipe(
              Effect.provideService(StreamFrameSink, {
                emit: (frame) =>
                  Effect.sync(() => {
                    frames.push(frame);
                  }),
              }),
            ),
      );
      // Then
      expect(result).toEqual({
        exitCode: 0,
        stdout: `explicit-env\n<two words>\n<>\n<$(echo injected)>\n${root}\ntail`,
        stderr: "diagnostic\n",
      });
      if (mode === "live") {
        expect(
          frames
            .filter((frame) => frame._tag === "stdout")
            .map((frame) => frame.chunk)
            .join(""),
        ).toBe(result.stdout);
        expect(
          frames
            .filter((frame) => frame._tag === "stderr")
            .map((frame) => frame.chunk)
            .join(""),
        ).toBe(result.stderr);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("preserves shell events and redacts scoped tokens in live lines", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-shell-stream-"));
  const secret = "scoped-stream-secret";
  const frames: StreamFrameSinkFrame[] = [];
  const events: LandoEvent[] = [];
  const layer = Layer.mergeAll(
    BunShellRunner.layer(() => {
      throw new TypeError("unused interactive IO");
    }),
    Layer.succeed(
      StreamFrameSink,
      StreamFrameSink.of({
        emit: (frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
      }),
    ),
    Layer.succeed(
      RedactionService,
      RedactionService.of({
        registerValues: registerRedactionValues,
        forProfile: (profile, options) =>
          Effect.succeed(createRedactor(profile, { values: options?.redactionTokens ?? [] })),
      }),
    ),
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event: LandoEvent) =>
          Effect.sync(() => {
            events.push(event);
          }),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<never>(),
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  try {
    const script = join(root, "probe.bun.sh");
    await writeFile(script, `echo ${secret}; echo ${secret} 1>&2; echo -n ${secret}\n`);
    // When
    const result = await Effect.runPromise(
      BunShellRunner.withShellRedactionTokens(
        [secret],
        Effect.flatMap(ShellRunner, (shell) => shell.runScript(script, { cwd: root })),
      ).pipe(Effect.provide(layer)),
    );
    // Then
    expect(result).toEqual({ exitCode: 0, stdout: `${secret}\n${secret}`, stderr: `${secret}\n` });
    expect(frames.map((frame) => frame.chunk)).toEqual(
      expect.arrayContaining(["[redacted]\n", "[redacted]"]),
    );
    expect(JSON.stringify(frames)).not.toContain(secret);
    expect(events.map((event) => event._tag)).toEqual(["pre-shell-exec", "post-shell-exec"]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain("[redacted]");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
