import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  GlobalConfig,
  type LandofileEvents,
  ProviderId,
  type ToolingTaskShape,
} from "@lando/sdk/schema";
import { createPayloadRedactor } from "@lando/sdk/secrets";
import {
  AppPlanner,
  ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
  ShellRunner,
  ToolingEngine,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer, Schema } from "effect";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";
import { runTooling } from "../../src/operations/tooling.ts";
import { withProjectEvents } from "../../src/planner/effective-events.ts";
import * as EventRuntime from "../../src/services/event-service.ts";
import { makeShellRunnerService } from "../../src/services/shell-runner.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const harness = (
  task: ToolingTaskShape,
  events?: LandofileEvents,
  onFrame?: (frame: StreamFrameSinkFrame) => void,
) => {
  const frames: StreamFrameSinkFrame[] = [];
  const basePlan: CurrentExecutableAppPlan = {
    valueModel: 1,
    id: AppId.make("host-output"),
    name: "host-output",
    slug: "host-output",
    root: AbsolutePath.make(process.cwd()),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    fileSync: [],
    stores: [],
    extensions: {},
    metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-12T00:00:00Z"), source: "test", runtime: 4 },
  };
  const plan = events === undefined ? basePlan : withProjectEvents(basePlan, events);
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const layer = Layer.mergeAll(
    testEnvironmentResolverLayer,
    EventRuntime.layer,
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    Layer.succeed(
      ShellRunner,
      makeShellRunnerService(() => {
        throw new Error("unused REPL");
      }, ownerOnlyFileAccess),
    ),
    Layer.succeed(
      ToolingEngine,
      ToolingEngine.of({
        id: "buffered-test",
        run: (invocation) =>
          Effect.succeed({
            tool: invocation.tool,
            service: invocation.service ?? "web",
            exitCode: 0,
            stdout: "provider",
            stderr: "",
          }),
      }),
    ),
    Layer.succeed(
      LandofileService,
      LandofileService.of({ discover: compileTestLandofile({ name: plan.name, tooling: { probe: task } }) }),
    ),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([plan.provider]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(TestRuntimeProvider),
      }),
    ),
  );
  const sink = Layer.succeed(
    StreamFrameSink,
    StreamFrameSink.of({
      emit: (frame) =>
        Effect.sync(() => {
          frames.push(frame);
          onFrame?.(frame);
        }),
    }),
  );
  const redactionService = makeRedactionService();
  const redaction = Layer.succeed(RedactionService, redactionService);
  return {
    frames,
    run: (
      options: { readonly sink?: boolean; readonly redaction?: boolean; readonly payload?: boolean } = {},
    ) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const values = yield* redactionService.payloadValues();
          const payloads = { stdout: createPayloadRedactor(values), stderr: createPayloadRedactor(values) };
          const protectedSink = Layer.succeed(StreamFrameSink, {
            emit: (frame) =>
              Effect.sync(() => {
                const bytes =
                  typeof frame.chunk === "string" ? new TextEncoder().encode(frame.chunk) : frame.chunk;
                frames.push({ ...frame, kind: "bytes", chunk: payloads[frame._tag].write(bytes) });
              }),
          });
          return yield* runTooling({ name: "probe" }).pipe(
            Effect.provide(
              Layer.mergeAll(
                layer,
                options.sink === false ? Layer.empty : options.payload === true ? protectedSink : sink,
                options.redaction === false ? Layer.empty : redaction,
              ),
            ),
            Effect.result,
            Effect.ensuring(
              Effect.sync(() => {
                if (options.payload === true)
                  for (const tag of ["stdout", "stderr"] as const)
                    frames.push({ kind: "bytes", _tag: tag, chunk: payloads[tag].flush() });
              }),
            ),
          );
        }),
      ),
  };
};

const joined = (frames: ReadonlyArray<StreamFrameSinkFrame>, tag: "stdout" | "stderr") =>
  frames
    .filter((frame) => frame._tag === tag)
    .map((frame) => (typeof frame.chunk === "string" ? frame.chunk : new TextDecoder().decode(frame.chunk)))
    .join("");

test("keeps a registered secret masked across separately executed host commands", async () => {
  // Given
  const h = harness({
    service: ":host",
    env: { SECRET: "split-host-secret" },
    cmds: ["printf split-host-; printf split-host- 1>&2", "printf secret; printf secret 1>&2"],
  });
  // When
  const result = await h.run({ payload: true });
  // Then
  expect(result).toMatchObject({ _tag: "Success", success: { exitCode: 0 } });
  expect(result).not.toHaveProperty("success.stdout");
  expect(result).not.toHaveProperty("success.stderr");
  expect(joined(h.frames, "stdout")).toBe("[redacted]");
  expect(joined(h.frames, "stderr")).toBe("[redacted]");
});

test("delivers a host partial line before the body is allowed to finish", async () => {
  // Given
  const gate = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      await gate.promise;
      return new Response("ok");
    },
  });
  const h = harness(
    {
      service: ":host",
      cmd: `printf one; bun -e 'await fetch("http://127.0.0.1:${server.port}")'; printf two`,
    },
    undefined,
    () => {
      if (joined(h.frames, "stdout") === "one") gate.resolve();
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // When
    const result = await Promise.race([
      h.run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Host output was buffered")), 3000);
      }),
    ]);
    // Then
    expect(result).toMatchObject({ _tag: "Success", success: { exitCode: 0 } });
    expect(result).not.toHaveProperty("success.stdout");
    expect(joined(h.frames, "stdout")).toBe("onetwo");
  } finally {
    clearTimeout(timer);
    gate.resolve();
    server.stop(true);
  }
});

test("streams host channels through the sink without collecting the body", async () => {
  // Given a secret split across two separately executed host commands in both channels.
  const h = harness({
    service: ":host",
    env: { SECRET: "split-host-secret" },
    cmds: ["printf split-host-; printf split-host- 1>&2", "printf secret; printf secret 1>&2"],
  });
  // When the body runs with a live sink.
  const result = await h.run();
  // Then channels stream as authored and the result omits uncaptured output.
  expect(joined(h.frames, "stdout")).toBe("split-host-secret");
  expect(joined(h.frames, "stderr")).toBe("split-host-secret");
  expect(h.frames.every((frame) => frame.kind === "bytes")).toBe(true);
  expect(result).toMatchObject({
    _tag: "Success",
    success: { exitCode: 0 },
  });
  expect(result).not.toHaveProperty("success.stdout");
  expect(result).not.toHaveProperty("success.stderr");
  expect(result).not.toHaveProperty("success.rendered");
});

test("emits failure stderr before returning the body exit code", async () => {
  // Given a nonzero body and a post hook that must not execute.
  const h = harness(
    { service: ":host", cmd: "printf diagnostic 1>&2; exit 7" },
    { "post-probe": [{ service: ":host", cmd: "exit 9" }] },
  );
  // When invoked.
  const result = await h.run();
  // Then only the nonempty channel is emitted and the body exit wins.
  expect(joined(h.frames, "stderr")).toBe("diagnostic");
  expect(result).toMatchObject({
    _tag: "Success",
    success: { exitCode: 7 },
  });
  expect(result).not.toHaveProperty("success.stderr");
});

test.each(["pre", "post"] as const)(
  "handles %s hook failure at the body-output boundary",
  async (position) => {
    // Given a failing bracket around a host body.
    const h = harness(
      { service: ":host", cmd: "printf body" },
      { [`${position}-probe`]: [{ service: ":host", cmd: "exit 9" }] },
    );
    // When invoked.
    const result = await h.run();
    // Then a pre failure has no body output; a post failure cannot suppress completed output.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LandofileEventStepFailedError", event: `${position}-probe` },
    });
    expect(joined(h.frames, "stdout")).toBe(position === "pre" ? "" : "body");
  },
);

test("rejects a host marker in a service-selection flag before output", async () => {
  // Given
  const h = harness({ service: ":target", flags: { target: { default: ":host" } }, cmd: "printf body" });
  // When
  const result = await h.run();
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError" } });
  expect(h.frames).toEqual([]);
});

test("retains buffered result ownership when no sink exists", async () => {
  // Given an embedding host without the CLI sink.
  const h = harness({ service: ":host", cmd: "printf body" });
  // When invoked.
  const result = await h.run({ sink: false });
  // Then the caller still owns rendering the collected body.
  expect(h.frames).toEqual([]);
  expect(result).toMatchObject({ _tag: "Success", success: { stdout: "body", exitCode: 0 } });
  if (result._tag === "Success") expect("rendered" in result.success).toBe(false);
});

test.each([
  { service: "web", cmd: "provider" },
  {
    cmds: [
      { service: ":host", cmd: "printf host" },
      { service: "web", cmd: "provider" },
    ],
  },
  { service: ":target", flags: { target: { default: "web" } }, cmd: "provider" },
] satisfies ToolingTaskShape[])("delivers returned provider and mixed body output once: %j", async (task) => {
  // Given a body with at least one resolved provider invocation.
  const h = harness(task);
  // When invoked with a sink.
  const result = await h.run();
  // Then every invocation delivers its channel once, whether streamed or returned.
  expect(result).toMatchObject({ _tag: "Success", success: { exitCode: 0 } });
  if (result._tag === "Success") expect("rendered" in result.success).toBe(false);
  const hasHost = JSON.stringify(task).includes(":host");
  expect(joined(h.frames, "stdout")).toBe(hasHost ? "hostprovider" : "provider");
});
import { compileTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
