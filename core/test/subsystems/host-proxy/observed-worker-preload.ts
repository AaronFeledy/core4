import { mock } from "bun:test";
import { appendFile } from "node:fs/promises";
import { ProviderId } from "@lando/sdk/schema";
import { EventService, RouterService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { makeLandoRuntime } from "../../../src/runtime/layer.ts";

const originalRuntime = makeLandoRuntime;
const eventPath = process.argv[process.argv.indexOf("--test-events") + 1];
if (eventPath === undefined) throw new TypeError("Missing test event path");
const provider = {
  ...TestRuntimeProvider,
  id: "lando",
  inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
    Effect.succeed({
      app: target.app,
      service: target.service,
      providerId: ProviderId.make("lando"),
      status: "running",
      state: "running",
      publications: { status: "present" as const, bindings: [] },
    }),
};
const registry = Layer.succeed(
  RuntimeProviderRegistry,
  RuntimeProviderRegistry.of({
    list: Effect.succeed([ProviderId.make("lando")]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
    appliedPlansFor: () => Effect.succeed([]),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
  }),
);
const router = Layer.succeed(
  RouterService,
  RouterService.of({
    ...makeTestRouterService(),
    observeRoutes: (_app, routes) => {
      const publications = routes.flatMap((route) => {
        const schemes = route.scheme === "both" ? (["http", "https"] as const) : [route.scheme];
        return schemes.map((scheme) => ({
          route,
          authority: {
            hostname: route.hostname,
            scheme,
            port: scheme === "http" ? 80 : 443,
          },
        }));
      });
      return Effect.succeed({
        configuredAuthorities: publications.map(({ authority }) => authority),
        observation: { status: "present" as const, publications },
      });
    },
  }),
);

mock.module("../../../src/runtime/layer.ts", () => ({
  makeLandoRuntime: (options: unknown) => {
    const base = originalRuntime(options);
    const events = Layer.effect(
      EventService,
      Effect.gen(function* () {
        const actual = yield* EventService;
        return EventService.of({
          ...actual,
          publish: (event) =>
            actual
              .publish(event)
              .pipe(
                Effect.andThen(
                  event._tag === "pre-host-proxy-call"
                    ? Effect.promise(() => appendFile(eventPath, `${JSON.stringify(event.request)}\n`))
                    : Effect.void,
                ),
              ),
        });
      }),
    ).pipe(Layer.provide(base));
    return Layer.mergeAll(base, registry, router, events);
  },
}));
