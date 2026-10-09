import { expect, test } from "bun:test";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  GlobalConfig,
  type LandofileEvents,
  ProviderId,
  type ToolingTaskShape,
} from "@lando/sdk/schema";
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
import { attachEffectiveEvents } from "../../src/planner/effective-events.ts";
import * as EventRuntime from "../../src/services/event-service.ts";
import { makeShellRunnerService } from "../../src/services/shell-runner.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

const harness = (task: ToolingTaskShape, events?: LandofileEvents) => {
  const frames: StreamFrameSinkFrame[] = [];
  const plan: AppPlan = {
    id: AppId.make("host-output"),
    name: "host-output",
    slug: "host-output",
    root: AbsolutePath.make(process.cwd()),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    networks: [],
    fileSync: [],
    stores: [],
    extensions: {},
    metadata: { resolvedAt: DateTime.makeUnsafe("2026-09-12T00:00:00Z"), source: "test", runtime: 4 },
  };
  if (events !== undefined) attachEffectiveEvents(plan, events);
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const layer = Layer.mergeAll(
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
      LandofileService.of({ discover: Effect.succeed({ name: plan.name, tooling: { probe: task } }) }),
    ),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
    Layer.succeed(
      ConfigService,
      ConfigService.of({ load: Effect.succeed(config), get: (key) => Effect.succeed(config[key]) }),
    ),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
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
        }),
    }),
  );
  const redaction = Layer.succeed(
    RedactionService,
    RedactionService.of({
      registerValues: () => Effect.void,
      forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
    }),
  );
  return {
    frames,
    run: (options: { readonly sink?: boolean; readonly redaction?: boolean } = {}) =>
      Effect.runPromise(
        runTooling({ name: "probe" }).pipe(
          Effect.provide(
            Layer.mergeAll(
              layer,
              options.sink === false ? Layer.empty : sink,
              options.redaction === false ? Layer.empty : redaction,
            ),
          ),
          Effect.result,
        ),
      ),
  };
};

test.each([true, false])(
  "redacts complete host channels once with redaction service %s",
  async (redaction) => {
    // Given a secret split across two separately executed host commands in both channels.
    const h = harness({
      service: ":host",
      env: { SECRET: "split-host-secret" },
      cmds: ["printf split-host-; printf split-host- 1>&2", "printf secret; printf secret 1>&2"],
    });
    // When the buffered body completes.
    const result = await h.run({ redaction });
    // Then each complete channel is redacted once, while the collected result stays intact.
    expect(h.frames).toEqual([
      { _tag: "stdout", chunk: "[redacted]", raw: true },
      { _tag: "stderr", chunk: "[redacted]", raw: true },
    ]);
    expect(result).toMatchObject({
      _tag: "Success",
      success: { stdout: "split-host-secret", stderr: "split-host-secret", exitCode: 0, rendered: true },
    });
  },
);

test("emits failure stderr before returning the body exit code", async () => {
  // Given a nonzero body and a post hook that must not execute.
  const h = harness(
    { service: ":host", cmd: "printf diagnostic 1>&2; exit 7" },
    { "post-probe": [{ service: ":host", cmd: "exit 9" }] },
  );
  // When invoked.
  const result = await h.run();
  // Then only the nonempty channel is emitted and the body exit wins.
  expect(h.frames).toEqual([{ _tag: "stderr", chunk: "diagnostic", raw: true }]);
  expect(result).toMatchObject({
    _tag: "Success",
    success: { exitCode: 7, stderr: "diagnostic", rendered: true },
  });
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
    expect(h.frames).toEqual(position === "pre" ? [] : [{ _tag: "stdout", chunk: "body", raw: true }]);
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
  if (result._tag === "Success") expect(result.success.rendered).toBeUndefined();
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
] satisfies ToolingTaskShape[])("does not replay provider or mixed body output: %j", async (task) => {
  // Given a body with at least one resolved provider invocation.
  const h = harness(task);
  // When invoked with a sink.
  const result = await h.run();
  // Then the top-level callback contributes no frames.
  expect(result).toMatchObject({ _tag: "Success", success: { exitCode: 0, rendered: true } });
  expect(h.frames).toEqual([]);
});
