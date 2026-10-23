import { afterEach, expect, test } from "bun:test";
import {
  RedactionService,
  makeRedactionService,
  resetRegisteredRedactionValuesForTesting,
} from "@lando/redaction/service";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { EventService, RuntimeProviderRegistry, ToolingEngine } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer } from "effect";
import { runAppEvent } from "../../src/operations/events.ts";
import { StreamFrameSink, createCollectingStreamFrameSink } from "../../src/operations/stream-frame-sink.ts";
import { withProjectEvents } from "../../src/planner/effective-events.ts";
import { attachEffectiveTooling } from "../../src/planner/effective-tooling.ts";
import * as EventRuntime from "../../src/services/event-service.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

for (const kind of ["cmd", "task"] as const) {
  for (const live of [false, true]) {
    test(`${kind} hook output narrates only outside a live sink: live=${live}`, async () => {
      // Given
      const secret = "hook-progress-canary";
      const task = { service: "web", cmd: "hook", env: { API_TOKEN: secret } };
      const basePlan: AppPlan = {
        id: AppId.make("event-output"),
        name: "event-output",
        slug: "event-output",
        root: AbsolutePath.make(process.cwd()),
        provider: ProviderId.make("test"),
        services: {},
        routes: [],
        networks: [],
        fileSync: [],
        stores: [],
        extensions: {},
        metadata: { resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"), source: "test", runtime: 4 },
      };
      const plan = withProjectEvents(basePlan, { "post-start": [kind === "cmd" ? task : { task: "named" }] });
      attachEffectiveTooling(plan, { named: task });
      const payload = createCollectingStreamFrameSink();
      const layer = Layer.mergeAll(
        EventRuntime.layer,
        Layer.succeed(
          RedactionService,
          makeRedactionService({
            id: "empty",
            list: Effect.succeed([]),
            get: () => Effect.succeed(""),
            has: () => Effect.succeed(false),
          }),
        ),
        Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
        Layer.succeed(RuntimeProviderRegistry, {
          appliedPlansFor: () => Effect.succeed([]),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          list: Effect.succeed([plan.provider]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
        }),
        Layer.succeed(ToolingEngine, {
          id: "returning-hook",
          run: () =>
            Effect.succeed({
              tool: "hook",
              service: "web",
              exitCode: 0,
              stdout: `line-1\n${secret}\n`,
              stderr: "hook-stderr\n",
            }),
        }),
        live ? Layer.succeed(StreamFrameSink, payload.sink) : Layer.empty,
      );
      // When
      const details = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* runAppEvent(plan, "post-start");
          return yield* events.query("task.detail");
        }).pipe(Effect.provide(layer)),
      );
      // Then
      expect(details.map((detail) => detail.line)).toEqual(
        live ? [] : ["line-1", "[redacted]", "hook-stderr"],
      );
      expect(payload.result()).toEqual(
        live ? { stdout: `line-1\n${secret}\n`, stderr: "hook-stderr\n" } : { stdout: "", stderr: "" },
      );
    });
  }
}
