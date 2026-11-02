import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { sha256Hex } from "@lando/sdk/digest";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, ToolingEngine } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Layer } from "effect";
import { runAppEvent } from "../../src/operations/events.ts";
import { withProjectEvents } from "../../src/planner/effective-events.ts";
import * as EventService from "../../src/services/event-service.ts";
import { testEnvironmentResolverLayerFor } from "../environment-values.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

test("event lowered env keeps an authorized literal whole-token in failure output", async () => {
  const base: AppPlan = {
    id: AppId.make("tier-event"),
    name: "tier-event",
    slug: "tier-event",
    root: AbsolutePath.make("/tmp/tier-event"),
    provider: ProviderId.make("test"),
    services: {},
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 },
  };
  const plan: AppPlan = {
    ...withProjectEvents(base, {
      "pre-start": [{ cmd: "fail", env: { DB_PASSWORD: "wordpress" }, silent: true }],
    }),
    committedLiteralDigests: [sha256Hex("wordpress")],
  };
  const redaction = makeRedactionService();
  const resolver = testEnvironmentResolverLayerFor(redaction);
  const runtime = Layer.mergeAll(
    resolver,
    Layer.succeed(RedactionService, redaction),
    EventService.layer.pipe(Layer.provide(resolver)),
    Layer.succeed(PrivateFileAccessService, ownerOnlyFileAccess),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([ProviderId.make("test")]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.succeed(TestRuntimeProvider),
      }),
    ),
    Layer.succeed(
      ToolingEngine,
      ToolingEngine.of({
        id: "test",
        run: (invocation) =>
          Effect.succeed({
            tool: invocation.tool,
            service: invocation.service ?? ":lando",
            exitCode: 1,
            stdout: "wordpress wordpress-seo",
            stderr: "",
          }),
      }),
    ),
  );
  const failure = await Effect.runPromise(
    Effect.flip(runAppEvent(plan, "pre-start").pipe(Effect.provide(runtime))),
  );
  expect(failure).toMatchObject({
    _tag: "LandofileEventStepFailedError",
    outputTail: "[redacted] wordpress-seo",
  });
});
