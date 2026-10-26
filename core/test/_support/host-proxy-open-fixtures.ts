import { DateTime, Effect, Exit, Layer, Stream } from "effect";

import { collectPlanConnections } from "@lando/engine/operations/connection-collector";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { buildCommandResultEnvelope, failureOutcomeFromCause } from "@lando/sdk/command-result";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  type RoutePlan,
  ServiceName,
} from "@lando/sdk/schema";
import {
  EventService,
  type LandoEvent,
  RouterService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  ShellRunner,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";

import { type OpenAppOptions, OpenAppResultSchema, openForPlan } from "../../src/cli/commands/open.ts";

export const route = (
  over: Pick<RoutePlan, "hostname" | "scheme"> & { readonly service: string },
): RoutePlan => ({
  priority: 2,
  ...over,
  service: ServiceName.make(over.service),
  backend: { service: ServiceName.make(over.service), protocol: "http", port: 80 },
});

export const makePlan = (routes: RoutePlan[], serviceNames: string[]): AppPlan => {
  const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "host-proxy-open", runtime: 4 as const };
  return {
    id: AppId.make("myapp"),
    name: "myapp",
    slug: "myapp",
    root: AbsolutePath.make("/srv/apps/myapp"),
    provider: ProviderId.make("test"),
    services: Object.fromEntries(
      serviceNames.map((name) => [
        name,
        {
          name: ServiceName.make(name),
          provider: ProviderId.make("test"),
          type: "generic",
          primary: true,
          environment: {},
          mounts: [],
          routes: [],
          endpoints: [{ _tag: "internal", protocol: "http", port: 80, name: "http", primary: true }],
          dependsOn: [],
          hostAliases: [],
          metadata,
          extensions: {},
        },
      ]),
    ),
    routes,
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

export const recordingEventLayer = () => {
  const events: LandoEvent[] = [];
  const layer = Layer.succeed(
    EventService,
    EventService.of({
      publish: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      subscribe: () => Stream.die("unused event subscription"),
      subscribeQueue: Effect.die("unused event queue"),
      waitFor: () => Effect.die("unused event wait"),
      waitForAny: () => Effect.die("unused event wait"),
      query: () => Effect.die("unused event query"),
    }),
  );
  return { events, layer };
};

export const silentEventLayer = () => recordingEventLayer().layer;

export const redactionLayer = () => Layer.succeed(RedactionService, makeRedactionService());

const observedProvider: RuntimeProviderShape = {
  ...TestRuntimeProvider,
  inspect: (target) =>
    Effect.succeed({
      app: target.app,
      service: target.service,
      providerId: ProviderId.make("test"),
      status: "running",
      state: "running",
      publications: { status: "present", bindings: [] },
    }),
};

export const commandServices = (
  eventLayer: Layer.Layer<EventService>,
  httpsPort = 443,
  provider: RuntimeProviderShape = observedProvider,
) =>
  Layer.mergeAll(
    Layer.succeed(
      ShellRunner,
      ShellRunner.of({
        exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
        run: () => Effect.die("unused shell run"),
        runScript: () => Effect.die("unused shell script"),
        interactive: () => Effect.die("unused interactive shell"),
      }),
    ),
    eventLayer,
    redactionLayer(),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        list: Effect.succeed([ProviderId.make("test")]),
        capabilities: Effect.succeed(provider.capabilities),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        appliedPlansFor: () => Effect.succeed([]),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        select: () => Effect.succeed(provider),
      }),
    ),
    Layer.succeed(
      RouterService,
      RouterService.of({
        ...makeTestRouterService(),
        status: Effect.die("open must not infer liveness from router status"),
        observeRoutes: () =>
          Effect.succeed({
            configuredAuthorities: [{ hostname: "web.myapp.lndo.site", scheme: "https", port: httpsPort }],
            observation: {
              status: "present",
              publications: [
                {
                  route: route({ hostname: "web.myapp.lndo.site", scheme: "https", service: "web" }),
                  authority: { hostname: "web.myapp.lndo.site", scheme: "https", port: httpsPort },
                },
              ],
            },
          }),
      }),
    ),
  );

export const hostSideEnvelope = (plan: AppPlan, options: OpenAppOptions) => {
  const program = Effect.gen(function* () {
    const redactor = yield* (yield* RedactionService).forProfile("secrets");
    const outcome = yield* Effect.exit(
      Effect.gen(function* () {
        const connections = yield* collectPlanConnections(plan);
        return yield* openForPlan(plan, options, connections);
      }),
    );
    const encoded = Exit.isSuccess(outcome)
      ? { outcome: { _tag: "success" as const, value: outcome.value }, exitCode: 0 }
      : { outcome: failureOutcomeFromCause(outcome.cause), exitCode: 1 };
    const envelope = yield* buildCommandResultEnvelope({
      command: "app:open",
      resultSchema: OpenAppResultSchema,
      outcome: encoded.outcome,
      redactor,
    });
    return { envelope, exitCode: encoded.exitCode };
  });
  return Effect.runPromise(program.pipe(Effect.provide(commandServices(silentEventLayer()))));
};
