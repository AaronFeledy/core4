import { describe, expect, test } from "bun:test";
import { Context, DateTime, Effect, Layer, Stream } from "effect";

import { TestRuntimeProvider, makeTestRuntime } from "@lando/core/testing";
import { execApp } from "@lando/engine/operations/exec";
import { StreamFrameSink, type StreamFrameSinkFrame } from "@lando/engine/operations/stream-frame-sink";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import * as RendererRuntime from "@lando/renderer/runtime";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, type RuntimeProviderShape } from "@lando/sdk/services";

import { execSpec } from "../../src/cli/command-specs/app/exec.ts";
import { attachExecHostIo } from "../../src/cli/exec-host-io.ts";

const payload = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x80, 0xfe, 0x7f, 0x00]);
const providerId = ProviderId.make("test");
const serviceName = ServiceName.make("appserver");
const plan: AppPlan = {
  id: AppId.make("exec-binary-pipe"),
  name: "exec-binary-pipe",
  slug: "exec-binary-pipe",
  root: AbsolutePath.make("/tmp/exec-binary-pipe"),
  provider: providerId,
  services: {
    [serviceName]: {
      name: serviceName,
      type: "node",
      provider: providerId,
      primary: true,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: {
        resolvedAt: DateTime.makeUnsafe("2026-10-14T00:00:00Z"),
        source: "exec-binary-pipe.test",
        runtime: 4,
      },
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-10-14T00:00:00Z"),
    source: "exec-binary-pipe.test",
    runtime: 4,
  },
  extensions: {},
};

const concat = (chunks: ReadonlyArray<string | Uint8Array>): Uint8Array => {
  const encoded = chunks.map((chunk) =>
    typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
  );
  const bytes = new Uint8Array(encoded.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of encoded) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const collectStdin = async (stream: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
  if (stream === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return concat(chunks);
};

const pipedStdin = (bytes: Uint8Array) => ({
  isTTY: false,
  readableFlowing: null,
  resume: () => {},
  pause: () => {},
  async *[Symbol.asyncIterator]() {
    yield bytes;
  },
  iterator: () => pipedStdin(bytes)[Symbol.asyncIterator](),
});

const terminalStdin = {
  isTTY: true,
  readableFlowing: null,
  resume: () => {},
  pause: () => {},
  async *[Symbol.asyncIterator]() {},
  iterator: () => terminalStdin[Symbol.asyncIterator](),
};

describe("piped exec binary archives", () => {
  test("does not allocate a PTY when stdout is redirected and stdin is a TTY", () => {
    // Given: an interactive keyboard and a redirected archive sink, matching
    // `lando exec appserver -- tar -czf - -C /app . > files.tgz`.
    const options = {
      command: ["tar", "-czf", "-", "-C", "/app", "."],
      tty: false,
      interactive: false,
    } as const;

    // When: the CLI sets tty from stdout.isTTY (false) before attachExecHostIo.
    const attached = attachExecHostIo(options, terminalStdin, { isTTY: false });

    // Then
    expect(attached.tty).toBe(false);
    expect(attached.hostTerminal).toBeUndefined();
    expect(attached.terminalResize).toBeUndefined();
    expect(attached.env).toBeUndefined();
  });

  test("forwards raw stdin bytes without a PTY", async () => {
    // Given: a host file piped into exec, matching
    // `lando exec appserver -- tar -xzf - -C /app < files.tgz`.
    const attached = attachExecHostIo(
      { command: ["tar", "-xzf", "-", "-C", "/app"], tty: false, interactive: false },
      pipedStdin(payload),
      { isTTY: true },
    );

    // When
    const received = await collectStdin(attached.stdinStream);

    // Then
    expect(attached.tty).toBe(false);
    expect(received).toEqual(payload);
  });

  test("round-trips binary bytes through exec in both directions without a PTY", async () => {
    // Given
    const receivedStdin: Uint8Array[] = [];
    const frames: StreamFrameSinkFrame[] = [];
    const ttys: Array<boolean | undefined> = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      execStream: (_target, command) =>
        Stream.fromIterableEffect(
          Effect.promise(async () => {
            ttys.push(command.tty);
            receivedStdin.push(await collectStdin(command.stdinStream));
            return [
              { kind: "stdout" as const, chunk: payload },
              { kind: "stderr" as const, chunk: new Uint8Array([0x00, 0xff]) },
              { exitCode: 0 },
            ];
          }),
        ),
    };
    const runtime = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
    const attached = attachExecHostIo(
      { command: ["tar", "-xzf", "-", "-C", "/data"], tty: false, interactive: false },
      pipedStdin(payload),
      { isTTY: false },
    );

    // When
    await Effect.runPromise(
      Effect.scoped(
        Layer.build(runtime.layer).pipe(
          Effect.map((context) => Context.add(context, AppPlanner, { plan: () => Effect.succeed(plan) })),
          Effect.flatMap((context) =>
            execApp(attached).pipe(
              Effect.provideService(
                StreamFrameSink,
                StreamFrameSink.of({
                  emit: (frame) => Effect.sync(() => frames.push(frame)),
                }),
              ),
              Effect.provide(context),
            ),
          ),
        ),
      ),
    );

    // Then: no PTY, stdin bytes reach the provider, stdout bytes leave the sink intact.
    expect(ttys).toEqual([undefined]);
    expect(receivedStdin).toHaveLength(1);
    expect(receivedStdin[0]).toEqual(payload);
    expect(concat(frames.filter((frame) => frame._tag === "stdout").map((frame) => frame.chunk))).toEqual(
      payload,
    );
    expect(concat(frames.filter((frame) => frame._tag === "stderr").map((frame) => frame.chunk))).toEqual(
      new Uint8Array([0x00, 0xff]),
    );
  });

  test("writes raw binary frames to redirected stdout without UTF-8 replacement", async () => {
    // Given
    const io = createBufferedRendererIO();
    const redaction = Layer.succeed(
      RedactionService,
      RedactionService.of({
        registerValues: registerRedactionValues,
        forProfile: () => Effect.succeed(createStandaloneRedactor("secrets", { sourceEnv: {} })),
      }),
    );
    const layer = RendererOutput.layerStreamFrameSink("text", io).pipe(
      Layer.provide(Layer.merge(RendererRuntime.layerPlainService(io), redaction)),
    );

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* StreamFrameSink;
        yield* sink.emit({ _tag: "stdout", chunk: payload, raw: true });
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(io.stdoutBytes()).toEqual(payload);
  });
});

describe("exec spec redirected stdout", () => {
  test("clears tty when stdout is a pipe even if stdin is a TTY", async () => {
    // Given
    const commands: Array<{ readonly tty?: boolean }> = [];
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      execStream: (_target, command) => {
        commands.push(command);
        return Stream.fromIterable([{ exitCode: 0 }]);
      },
    };
    const runtime = makeTestRuntime({ bootstrap: "app", with: { RuntimeProvider: provider } });
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

    try {
      // When
      await Effect.runPromise(
        Effect.scoped(
          Layer.build(runtime.layer).pipe(
            Effect.map((context) => Context.add(context, AppPlanner, { plan: () => Effect.succeed(plan) })),
            Effect.flatMap((context) =>
              execSpec
                .run({
                  hostIo: "cli",
                  parsedArgv: ["tar", "-czf", "-", "-C", "/app", "."],
                  flags: {},
                })
                .pipe(Effect.provide(context)),
            ),
          ),
        ),
      );
    } finally {
      if (stdinIsTTY === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
      else Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
      if (stdoutIsTTY === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
      else Object.defineProperty(process.stdout, "isTTY", stdoutIsTTY);
    }

    // Then
    expect(commands).toHaveLength(1);
    expect(commands[0]?.tty === true).toBe(false);
  });
});
