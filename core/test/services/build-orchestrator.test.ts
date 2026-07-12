import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, DateTime, Effect, Fiber, Layer, Stream } from "effect";

import { ProviderInternalError } from "@lando/core/errors";
import {
  type ArtifactBuildSpec,
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/core/services";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeLandoPaths } from "../../src/config/paths.ts";
import { RedactionService } from "../../src/redaction/service.ts";
import { BuildOrchestratorLive } from "../../src/services/build-orchestrator.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { StateStoreLive } from "../../src/state/service.ts";

const providerId = ProviderId.make("test");
const appId = AppId.make("myapp");
const appRoot = AbsolutePath.make("/srv/apps/myapp");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "build-orchestrator.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web" | "db"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "web" ? "node" : "postgres",
  provider: providerId,
  primary: name === "web",
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const db = servicePlan("db");

const plan: AppPlan = {
  id: appId,
  name: "My App",
  slug: "myapp",
  root: appRoot,
  provider: providerId,
  services: { [web.name]: web, [db.name]: db },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const buildLifecycleEntry = (event: unknown): readonly [unknown, unknown] | undefined => {
  if (!isRecord(event)) return undefined;
  if (event._tag !== "pre-build" && event._tag !== "post-build") return undefined;
  return [event._tag, event.serviceName];
};

const buildLifecycleDetails = (event: unknown) => {
  if (!isRecord(event)) return undefined;
  if (event._tag !== "pre-build" && event._tag !== "post-build") return undefined;
  const appRef = isRecord(event.appRef) ? event.appRef : undefined;
  return {
    appId: appRef?.id,
    appRoot: appRef?.root,
    serviceName: event.serviceName,
    providerId: event.providerId,
    timestamp: event.timestamp,
  };
};

const registryLayer = (provider = TestRuntimeProvider) =>
  Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });

const layer = (provider = TestRuntimeProvider) => {
  const pathsLive = Layer.succeed(PathsService, makeLandoPaths());
  const dependencies = Layer.mergeAll(EventServiceLive, pathsLive, registryLayer(provider), StateStoreLive);
  return Layer.mergeAll(dependencies, BuildOrchestratorLive.pipe(Layer.provide(dependencies)));
};

const layerWithRedaction = (provider: RuntimeProviderShape, redaction: Layer.Layer<RedactionService>) => {
  const pathsLive = Layer.succeed(PathsService, makeLandoPaths());
  const dependencies = Layer.mergeAll(
    EventServiceLive,
    pathsLive,
    registryLayer(provider),
    StateStoreLive,
    redaction,
  );
  return Layer.mergeAll(dependencies, BuildOrchestratorLive.pipe(Layer.provide(dependencies)));
};

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
});

const withTempUserRoots = async <T>(run: () => Promise<T>): Promise<T> => {
  const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-build-orchestrator-cache-")));
  const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  try {
    process.env.LANDO_USER_CACHE_ROOT = cacheRoot;
    process.env.LANDO_USER_DATA_ROOT = cacheRoot;
    return await run();
  } finally {
    if (previousCacheRoot === undefined) {
      // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
      delete process.env.LANDO_USER_CACHE_ROOT;
    } else {
      process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    }
    if (previousDataRoot === undefined) {
      // biome-ignore lint/performance/noDelete: env delete avoids Bun coercing undefined to "undefined".
      delete process.env.LANDO_USER_DATA_ROOT;
    } else {
      process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    }
    await rm(cacheRoot, { recursive: true, force: true });
  }
};

const serviceFeatureExtension = (service: ServicePlan) =>
  service.extensions["@lando/core/service-features"] as
    | {
        readonly buildSteps?: ReadonlyArray<{
          readonly id: string;
          readonly phase: string;
          readonly command: ReadonlyArray<string>;
        }>;
      }
    | undefined;

describe("BuildOrchestratorLive", () => {
  test("builds every service sequentially and publishes build events in order", async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: (spec: ArtifactBuildSpec) =>
        Effect.gen(function* () {
          expect(spec.app).toBe(plan.id);
          expect(spec.plan).toBe(plan);
          expect(spec.buildKey).toBeString();
          active += 1;
          maxActive = Math.max(maxActive, active);
          calls.push(String(spec.service));
          yield* Effect.sleep("10 millis");
          active -= 1;
          return { providerId, ref: `${spec.service}:test` };
        }),
    };

    const events = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const subscriber = yield* eventService
            .subscribe("*")
            .pipe(Stream.take(4), Stream.runCollect, Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* Effect.flatMap(BuildOrchestrator, (orchestrator) =>
            Effect.map(orchestrator.build(plan), (builtPlan) => {
              expect(builtPlan.services[web.name]?.artifact).toEqual({ kind: "ref", ref: "web:test" });
              expect(builtPlan.services[db.name]?.artifact).toEqual({ kind: "ref", ref: "db:test" });
            }),
          );
          return yield* Fiber.join(subscriber);
        }),
      ).pipe(Effect.provide(layer(provider))),
    );

    expect(calls).toEqual(["web", "db"]);
    expect(maxActive).toBe(1);
    expect(
      Array.from(events)
        .map(buildLifecycleEntry)
        .filter((entry) => entry !== undefined),
    ).toEqual([
      ["pre-build", ServiceName.make("web")],
      ["post-build", ServiceName.make("web")],
      ["pre-build", ServiceName.make("db")],
      ["post-build", ServiceName.make("db")],
    ]);
  });

  test("short-circuits on the original provider failure", async () => {
    const failure = new ProviderInternalError({
      providerId: "test",
      operation: "buildArtifact",
      message: "build failed",
    });
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: (spec: ArtifactBuildSpec) => {
        calls.push(String(spec.service));
        return spec.service === ServiceName.make("web")
          ? Effect.fail(failure)
          : Effect.succeed({ providerId, ref: `${spec.service}:test` });
      },
    };

    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(plan))).pipe(
        Effect.provide(layer(provider)),
      ),
    );

    expect(calls).toEqual(["web"]);
    expect(error).toBe(failure);
  });

  test("pulls ref-only artifacts when the provider advertises artifactPull", async () => {
    const artifactPlan: AppPlan = {
      ...plan,
      services: {
        [web.name]: { ...web, artifact: { kind: "ref", ref: "debian:12.11-slim" } },
      },
    };
    const pulls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: { readonly ref: string }) =>
        Effect.sync(() => {
          pulls.push(spec.ref);
          return { providerId, ref: spec.ref };
        }),
    };

    const builtPlan = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(artifactPlan)).pipe(
        Effect.provide(layer(provider)),
      ),
    );

    expect(pulls).toEqual(["debian:12.11-slim"]);
    expect(builtPlan.services[web.name]?.artifact).toEqual({ kind: "ref", ref: "debian:12.11-slim" });
  });

  test("keeps planned artifact digest when artifactPull returns no digest", async () => {
    const artifactPlan: AppPlan = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          artifact: { kind: "ref", ref: "debian:12.11-slim", digest: "sha256:planned" },
        },
      },
    };
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: { readonly ref: string }) => Effect.succeed({ providerId, ref: spec.ref }),
    };

    const builtPlan = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(artifactPlan)).pipe(
        Effect.provide(layer(provider)),
      ),
    );

    expect(builtPlan.services[web.name]?.artifact).toEqual({
      kind: "ref",
      ref: "debian:12.11-slim",
      digest: "sha256:planned",
    });
  });

  test("uses provider-returned artifact digest over planned digest", async () => {
    const artifactPlan: AppPlan = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          artifact: { kind: "ref", ref: "debian:12.11-slim", digest: "sha256:planned" },
        },
      },
    };
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: { readonly ref: string }) =>
        Effect.succeed({ providerId, ref: spec.ref, digest: "sha256:provider" }),
    };

    const builtPlan = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(artifactPlan)).pipe(
        Effect.provide(layer(provider)),
      ),
    );

    expect(builtPlan.services[web.name]?.artifact).toEqual({
      kind: "ref",
      ref: "debian:12.11-slim",
      digest: "sha256:provider",
    });
  });

  test("keeps ref-only artifacts local when the provider cannot pull artifacts", async () => {
    const artifactPlan: AppPlan = {
      ...plan,
      services: {
        [web.name]: { ...web, artifact: { kind: "ref", ref: "debian:12.11-slim" } },
      },
    };
    const pulls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: false },
      pullArtifact: (spec: { readonly ref: string }) =>
        Effect.sync(() => {
          pulls.push(spec.ref);
          return { providerId, ref: spec.ref };
        }),
    };

    const builtPlan = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(artifactPlan)).pipe(
        Effect.provide(layer(provider)),
      ),
    );

    expect(pulls).toEqual([]);
    expect(builtPlan.services[web.name]?.artifact).toEqual({ kind: "ref", ref: "debian:12.11-slim" });
  });

  test("redacts build event free-text fields while preserving DateTime timestamps", async () => {
    const secretProviderId = ProviderId.make("test-topsecret");
    const secretService = {
      ...web,
      name: ServiceName.make("web-topsecret"),
      provider: secretProviderId,
    } satisfies ServicePlan;
    const secretPlan: AppPlan = {
      ...plan,
      id: AppId.make("myapp-topsecret"),
      slug: "myapp-topsecret",
      root: AbsolutePath.make("/srv/topsecret/myapp"),
      provider: secretProviderId,
      services: { [secretService.name]: secretService },
    };
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: () => Effect.succeed({ providerId: secretProviderId, ref: "ok" }),
    };

    const events = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const subscriber = yield* eventService
            .subscribe("*")
            .pipe(Stream.take(2), Stream.runCollect, Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(secretPlan));
          return yield* Fiber.join(subscriber);
        }),
      ).pipe(Effect.provide(layerWithRedaction(provider, redactionLayer))),
    );

    expect(Array.from(events)).toHaveLength(2);
    for (const event of Array.from(events)
      .map(buildLifecycleDetails)
      .filter((entry) => entry !== undefined)) {
      expect(String(event.appId)).not.toContain("topsecret");
      expect(String(event.appId)).toContain("[redacted]");
      expect(String(event.appRoot)).not.toContain("topsecret");
      expect(String(event.appRoot)).toContain("[redacted]");
      expect(String(event.serviceName)).not.toContain("topsecret");
      expect(String(event.serviceName)).toContain("[redacted]");
      expect(String(event.providerId)).not.toContain("topsecret");
      expect(String(event.providerId)).toContain("[redacted]");
      expect(DateTime.isDateTime(event.timestamp)).toBe(true);
    }
  });

  test("includes env-derived tokens in the build-event redactor", async () => {
    const previousToken = process.env.BUN_AUTH_TOKEN;
    process.env.BUN_AUTH_TOKEN = "envbuildsecret";
    const secretProviderId = ProviderId.make("test-envbuildsecret");
    const secretService = {
      ...web,
      name: ServiceName.make("web-envbuildsecret"),
      provider: secretProviderId,
    } satisfies ServicePlan;
    const secretPlan: AppPlan = {
      ...plan,
      slug: "myapp-envbuildsecret",
      root: AbsolutePath.make("/srv/envbuildsecret/myapp"),
      provider: secretProviderId,
      services: { [secretService.name]: secretService },
    };
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: () => Effect.succeed({ providerId: secretProviderId, ref: "ok" }),
    };
    const envRedactionLayer = Layer.succeed(RedactionService, {
      forProfile: (_profile, options) =>
        Effect.succeed(createRedactor("secrets", { values: [options?.sourceEnv?.BUN_AUTH_TOKEN ?? ""] })),
    } satisfies Context.Tag.Service<typeof RedactionService>);

    try {
      const events = await Effect.runPromise(
        Effect.flatMap(EventService, (eventService) =>
          Effect.gen(function* () {
            const subscriber = yield* eventService
              .subscribe("*")
              .pipe(Stream.take(2), Stream.runCollect, Effect.fork);
            yield* Effect.sleep("10 millis");
            yield* Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(secretPlan));
            return yield* Fiber.join(subscriber);
          }),
        ).pipe(Effect.provide(layerWithRedaction(provider, envRedactionLayer))),
      );

      expect(JSON.stringify(Array.from(events))).not.toContain("envbuildsecret");
    } finally {
      if (previousToken === undefined) {
        Reflect.deleteProperty(process.env, "BUN_AUTH_TOKEN");
      } else {
        process.env.BUN_AUTH_TOKEN = previousToken;
      }
    }
  });

  test("resolves the build-event redactor at build time, not layer construction", async () => {
    let profileReads = 0;
    const secretService = {
      ...web,
      name: ServiceName.make("web-latersecret"),
    } satisfies ServicePlan;
    const secretPlan: AppPlan = {
      ...plan,
      slug: "myapp-latersecret",
      root: AbsolutePath.make("/srv/latersecret/myapp"),
      services: { [secretService.name]: secretService },
    };
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: () => Effect.succeed({ providerId, ref: "ok" }),
    };
    const lazyRedactionLayer = Layer.succeed(RedactionService, {
      forProfile: () =>
        Effect.sync(() => {
          profileReads += 1;
          return createRedactor("secrets", { values: ["latersecret"] });
        }),
    });

    const events = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const orchestrator = yield* BuildOrchestrator;
          expect(profileReads).toBe(0);
          const subscriber = yield* eventService
            .subscribe("*")
            .pipe(Stream.take(2), Stream.runCollect, Effect.fork);
          yield* Effect.sleep("10 millis");
          yield* orchestrator.build(secretPlan);
          return yield* Fiber.join(subscriber);
        }),
      ).pipe(Effect.provide(layerWithRedaction(provider, lazyRedactionLayer))),
    );

    expect(profileReads).toBe(1);
    expect(JSON.stringify(Array.from(events))).not.toContain("latersecret");
  });

  test("skips a warm scratch artifact result without re-running provider work", async () => {
    await withTempUserRoots(async () => {
      const artifactPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-toolbox-first"),
        slug: "scratch-toolbox-first",
        root: AbsolutePath.make("/tmp/topsecret/scratch-toolbox-first/root"),
        services: {
          [web.name]: {
            ...web,
            artifact: { kind: "ref", ref: "debian:12.11-slim" },
            environment: { PASSWORD: "topsecret" },
          },
        },
      };
      const repeatPlan: AppPlan = {
        ...artifactPlan,
        id: AppId.make("scratch-toolbox-second"),
        slug: "scratch-toolbox-second",
        root: AbsolutePath.make("/tmp/topsecret/scratch-toolbox-second/root"),
      };
      const pullCalls: string[] = [];
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
        pullArtifact: (spec: { readonly ref: string }) =>
          Effect.sync(() => {
            pullCalls.push(spec.ref);
            return { providerId, ref: spec.ref };
          }),
      };

      const events = await Effect.runPromise(
        Effect.flatMap(EventService, (eventService) =>
          Effect.gen(function* () {
            const orchestrator = yield* BuildOrchestrator;
            yield* orchestrator.build(artifactPlan);
            const builtRepeat = yield* orchestrator.build(repeatPlan);
            expect(builtRepeat.services[web.name]?.artifact).toEqual({
              kind: "ref",
              ref: "debian:12.11-slim",
            });
            return yield* eventService.query("build-step-skip");
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      const skipEvents = Array.from(events);
      expect(skipEvents).toEqual([
        expect.objectContaining({
          _tag: "build-step-skip",
          eventName: "build-step-skip",
          reason: "up-to-date",
          cached: true,
          serviceName: ServiceName.make("web"),
        }),
      ]);
      expect(pullCalls).toEqual(["debian:12.11-slim"]);
      expect(JSON.stringify(skipEvents)).not.toContain("/tmp/topsecret");
      expect(JSON.stringify(skipEvents)).not.toContain("PASSWORD");
      expect(JSON.stringify(skipEvents)).not.toContain("topsecret");
    });
  });

  test("keeps artifact digest on warm scratch artifact cache hits", async () => {
    await withTempUserRoots(async () => {
      const artifactPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-digest-first"),
        slug: "scratch-digest-first",
        root: AbsolutePath.make("/tmp/scratch-digest-first/root"),
        services: {
          [web.name]: {
            ...web,
            artifact: { kind: "ref", ref: "debian:12.11-slim", digest: "sha256:planned" },
          },
        },
      };
      const repeatPlan: AppPlan = {
        ...artifactPlan,
        id: AppId.make("scratch-digest-second"),
        slug: "scratch-digest-second",
        root: AbsolutePath.make("/tmp/scratch-digest-second/root"),
      };
      const pullCalls: string[] = [];
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
        pullArtifact: (spec: { readonly ref: string }) =>
          Effect.sync(() => {
            pullCalls.push(spec.ref);
            return { providerId, ref: spec.ref };
          }),
      };

      const builtRepeat = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(artifactPlan);
            return yield* orchestrator.build(repeatPlan);
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      expect(builtRepeat.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "debian:12.11-slim",
        digest: "sha256:planned",
      });
      expect(pullCalls).toEqual(["debian:12.11-slim"]);
    });
  });

  test("skips an identical warm scratch redirect artifact build", async () => {
    await withTempUserRoots(async () => {
      const calls: string[] = [];
      const context = await mkdtemp(join(tmpdir(), "lando-build-orchestrator-context-"));
      await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
      const planWithRedirect: AppPlan = {
        ...plan,
        id: AppId.make("scratch-toolbox-redirect-first"),
        slug: "scratch-toolbox-redirect-first",
        root: AbsolutePath.make("/tmp/scratch-toolbox-redirect-first/root"),
        services: {
          [web.name]: {
            ...web,
            artifact: {
              kind: "build",
              context: AbsolutePath.make(context),
              contentHash: "sha256:context-a",
            },
            extensions: {
              "@lando/core/service-features": {
                buildSteps: [
                  {
                    id: "lando-log-redirect:access",
                    phase: "build",
                    command: ["ln", "-sf", "/dev/stdout", "/logs/access.log"],
                  },
                ],
              },
            },
          },
        },
      };
      const repeatPlan: AppPlan = {
        ...planWithRedirect,
        id: AppId.make("scratch-toolbox-redirect-second"),
        slug: "scratch-toolbox-redirect-second",
        root: AbsolutePath.make("/tmp/scratch-toolbox-redirect-second/root"),
      };
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.sync(() => {
            calls.push(String(spec.service));
            return { providerId, ref: `${spec.service}:test` };
          }),
      };

      await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(planWithRedirect);
            yield* orchestrator.build(repeatPlan);
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      expect(calls).toEqual(["web"]);
      expect(
        serviceFeatureExtension(Object.values(planWithRedirect.services)[0] ?? web)?.buildSteps,
      ).toHaveLength(1);
    });
  });

  test("rebuilds when redirect build inputs change and retries cached failures", async () => {
    await withTempUserRoots(async () => {
      const calls: string[] = [];
      const context = await mkdtemp(join(tmpdir(), "lando-build-orchestrator-context-"));
      await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
      const planWithRedirect = (commandPath: string): AppPlan => ({
        ...plan,
        id: AppId.make(`scratch-toolbox-${commandPath.replace(/[^a-z0-9]/gi, "-")}`),
        slug: `scratch-toolbox-${commandPath.replace(/[^a-z0-9]/gi, "-")}`,
        root: AbsolutePath.make(`/tmp/scratch-toolbox-${commandPath.replace(/[^a-z0-9]/gi, "-")}/root`),
        services: {
          [web.name]: {
            ...web,
            artifact: {
              kind: "build",
              context: AbsolutePath.make(context),
              contentHash: "sha256:redirect-context",
            },
            extensions: {
              "@lando/core/service-features": {
                buildSteps: [
                  {
                    id: "lando-log-redirect:access",
                    phase: "build",
                    command: ["ln", "-sf", "/dev/stdout", commandPath],
                  },
                ],
              },
            },
          },
        },
      });
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.sync(() => {
            calls.push(String(spec.service));
            return { providerId, ref: `${spec.service}:test` };
          }),
      };

      await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(planWithRedirect("/logs/access.log"));
            yield* orchestrator.build(planWithRedirect("/logs/other.log"));
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      expect(calls).toEqual(["web", "web"]);

      const failure = new ProviderInternalError({
        providerId: "test",
        operation: "pullArtifact",
        message: "pull failed",
      });
      const retryCalls: string[] = [];
      const failingProvider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) => {
          retryCalls.push(String(spec.service));
          return retryCalls.length === 1
            ? Effect.fail(failure)
            : Effect.succeed({ providerId, ref: `${spec.service}:test` });
        },
      };
      await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* Effect.either(orchestrator.build(planWithRedirect("/logs/failure.log")));
            yield* orchestrator.build(planWithRedirect("/logs/failure.log"));
          }),
        ).pipe(Effect.provide(layer(failingProvider))),
      );

      expect(retryCalls).toEqual(["web", "web"]);
      expect(
        serviceFeatureExtension(Object.values(planWithRedirect("/logs/failure.log").services)[0] ?? web)
          ?.buildSteps,
      ).toHaveLength(1);
    });
  });
});
