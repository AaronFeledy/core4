import { mock } from "bun:test";
import { appendFile } from "node:fs/promises";
import type { LandoRuntimeOptions } from "@lando/engine/runtime/runtime-options";
import { ProviderId } from "@lando/sdk/schema";
import {
  ConfigService,
  EventService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import { makeLandoRuntime } from "../../../src/runtime/layer.ts";

const originalRuntime = makeLandoRuntime;
const eventPath =
  process.env.LANDO_TEST_HOST_PROXY_EVENTS ?? process.argv[process.argv.indexOf("--test-events") + 1];
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
  makeLandoRuntime: (options: LandoRuntimeOptions & { readonly bootstrap: "app" }) => {
    const base = originalRuntime(options);
    const observedRouter = Layer.effect(
      RouterService,
      Effect.gen(function* () {
        const config = yield* (yield* ConfigService).load;
        const port = config.router?.httpPort ?? 80;
        const paths = yield* PathsService;
        yield* Effect.promise(() =>
          appendFile(
            eventPath,
            `${JSON.stringify({ configPort: port, roots: paths.roots, platform: paths.platform })}\n`,
          ),
        );
        const service = yield* RouterService;
        return RouterService.of({
          ...service,
          observeRoutes: (app, routes) =>
            service.observeRoutes(app, routes).pipe(
              Effect.map((result) => ({
                ...result,
                configuredAuthorities: result.configuredAuthorities.map((authority) => ({
                  ...authority,
                  port,
                })),
                observation:
                  result.observation.status === "present"
                    ? {
                        ...result.observation,
                        publications: result.observation.publications.map((publication) => ({
                          ...publication,
                          authority: { ...publication.authority, port },
                        })),
                      }
                    : result.observation,
              })),
            ),
        });
      }),
    ).pipe(Layer.provide(Layer.merge(base, router)));
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
                  event._tag === "pre-host-proxy-call" || event._tag === "post-host-proxy-call"
                    ? Effect.promise(() => appendFile(eventPath, `${JSON.stringify(event)}\n`))
                    : Effect.void,
                ),
              ),
        });
      }),
    ).pipe(Layer.provide(base));
    return Layer.mergeAll(base, registry, observedRouter, events);
  },
}));
