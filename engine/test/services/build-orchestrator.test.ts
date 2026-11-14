import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import {
  ArtifactBuildError,
  ProviderInternalError,
  ProviderUnavailableError,
  StateStoreError,
} from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import {
  type ArtifactBuildSpec,
  type ArtifactPullPolicy,
  type ArtifactPullSpec,
  type BuildOptions,
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import {
  Cause,
  type Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Stream,
} from "effect";

// Each layer build gets its own in-memory store, so one test never observes another test's build results.
const stateStoreLayer = Layer.suspend(() => Layer.succeed(StateStore, makeTestStateStore().service));

import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import { buildKeyForService } from "../../src/services/build-key.ts";
import * as BuildOrchestratorLayer from "../../src/services/build-orchestrator.ts";
import {
  openAppBuildResults,
  openScratchBuildResults,
  recordBuildResult,
} from "../../src/services/build-results.ts";
import * as LandoEventService from "../../src/services/event-service.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const providerId = ProviderId.make("test");
const appId = AppId.make("myapp");
const appRoot = AbsolutePath.make("/srv/apps/myapp");

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
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
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const companionOf = (parent: ServicePlan): ServicePlan => ({
  ...parent,
  name: ServiceName.make(`${String(parent.name)}-schedule`),
  primary: false,
  dependsOn: [{ service: parent.name, condition: "service_started", required: true }],
  provenance: { clonedBy: { feature: "test.clone", from: String(parent.name) } },
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Predicate.isObject(value);

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
  Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      appliedPlansFor: () => Effect.succeed([]),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );

const layer = (provider = TestRuntimeProvider, injectedStateStoreLayer = stateStoreLayer) => {
  const pathsLayer = Layer.succeed(PathsService, makeLandoPaths());
  const dependencies = Layer.mergeAll(
    LandoEventService.layer,
    pathsLayer,
    registryLayer(provider),
    injectedStateStoreLayer,
  );
  return Layer.mergeAll(dependencies, BuildOrchestratorLayer.layer.pipe(Layer.provide(dependencies)));
};

const layerWithRedaction = (provider: RuntimeProviderShape, redaction: Layer.Layer<RedactionService>) => {
  const pathsLayer = Layer.succeed(PathsService, makeLandoPaths());
  const dependencies = Layer.mergeAll(
    LandoEventService.layer,
    pathsLayer,
    registryLayer(provider),
    stateStoreLayer,
    redaction,
  );
  return Layer.mergeAll(dependencies, BuildOrchestratorLayer.layer.pipe(Layer.provide(dependencies)));
};

const redactionLayer = Layer.succeed(
  RedactionService,
  RedactionService.of({
    ...makeRedactionService(),
    payloadValues: () => Effect.succeed(() => ({ substring: ["topsecret"], wholeToken: [] })),
    forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
  }),
);

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
      delete process.env.LANDO_USER_CACHE_ROOT;
    } else {
      process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
    }
    if (previousDataRoot === undefined) {
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

describe("BuildOrchestratorLayer.layer", () => {
  test("drops only the temporary CA bundle mount after successful and cached trust-store builds", async () => {
    await withTempUserRoots(async () => {
      // Given
      const digest = "a".repeat(64);
      const caEnvironment = {
        LANDO_CA_BUNDLE: "/etc/lando/certs/ca-bundle.pem",
        LANDO_CA_DIR: "/etc/lando/certs",
      };
      const buildSteps = [
        {
          id: "lando.security:trust-store",
          phase: "build",
          command: "install-trust",
          buildKeyInputs: { caDigests: [digest] },
          caFiles: [{ path: "/host/corp.pem", digest, archiveName: `lando-${digest}.crt` }],
        },
      ];
      const trustService: ServicePlan = {
        ...web,
        artifact: { kind: "ref", ref: "debian:12" },
        environment: caEnvironment,
        mounts: [
          {
            type: "bind",
            source: "/host/corp.pem",
            target: PortablePath.make(`/usr/local/share/ca-certificates/lando-${digest}.crt`),
            readOnly: true,
            realization: "passthrough",
          },
          {
            type: "bind",
            source: "/host/ca-bundle.pem",
            target: PortablePath.make("/etc/lando/certs/ca-bundle.pem"),
            readOnly: true,
            realization: "passthrough",
          },
        ],
        extensions: {
          "@lando/core/service-features": {
            buildSteps,
          },
        },
      };
      const firstPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-ca-first"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-ca-first" } },
        slug: "scratch-ca-first",
        services: { [web.name]: trustService },
      };
      const repeatPlan: AppPlan = {
        ...firstPlan,
        id: AppId.make("scratch-ca-second"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-ca-second" } },
        slug: "scratch-ca-second",
      };
      let builds = 0;
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
        pullArtifact: () => Effect.succeed({ providerId, ref: "debian:12", digest: "sha256:base" }),
        buildArtifact: () =>
          Effect.sync(() => {
            builds += 1;
            return { providerId, ref: "debian:12-lando-ca" };
          }),
      };

      // When
      const [built, cached] = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            const first = yield* orchestrator.build(firstPlan);
            const repeat = yield* orchestrator.build(repeatPlan);
            return [first, repeat] as const;
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then
      const builtService = built.services[web.name];
      const cachedService = cached.services[web.name];
      expect(builds).toBe(1);
      expect(builtService?.mounts.map((mount) => String(mount.target))).toEqual([
        `/usr/local/share/ca-certificates/lando-${digest}.crt`,
      ]);
      expect(cachedService?.mounts).toEqual(builtService?.mounts);
      expect(builtService?.environment.LANDO_CA_BUNDLE).toBe(caEnvironment.LANDO_CA_BUNDLE);
      expect(builtService?.environment.LANDO_CA_DIR).toBe(caEnvironment.LANDO_CA_DIR);
      expect(cachedService?.environment).toEqual(builtService?.environment);
      const expectedExtensions = {
        ...trustService.extensions,
        "@lando/container-runtime/create-artifact": {
          source: sha256Hex(canonicalJson({ artifact: trustService.artifact, buildSteps })),
          realized: sha256Hex(
            canonicalJson({ artifact: { kind: "ref", ref: "debian:12-lando-ca" }, buildSteps }),
          ),
        },
      };
      expect(builtService?.extensions).toEqual(expectedExtensions);
      expect(cachedService?.extensions).toEqual(expectedExtensions);
    });
  });

  test("builds three artifact services with the default bounded concurrency", async () => {
    // Given
    const cache = { ...db, name: ServiceName.make("cache") } satisfies ServicePlan;
    const concurrentPlan: AppPlan = {
      ...plan,
      services: { [web.name]: web, [db.name]: db, [cache.name]: cache },
    };
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: Effect.fnUntraced(function* (spec: ArtifactBuildSpec) {
        expect(spec.app).toBe(concurrentPlan.id);
        expect(spec.plan).toBe(concurrentPlan);
        expect(spec.buildKey).toBeString();
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(String(spec.service));
        yield* Effect.sleep("30 millis");
        active -= 1;
        return { providerId, ref: `${spec.service}:test` };
      }),
    };

    // When
    const events = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const subscriber = yield* eventService
            .subscribe("*")
            .pipe(Stream.filter((event) => buildLifecycleEntry(event) !== undefined))
            .pipe(Stream.take(6), Stream.runCollect, Effect.forkChild);
          yield* Effect.sleep("10 millis");
          yield* Effect.flatMap(BuildOrchestrator, (orchestrator) =>
            Effect.map(orchestrator.build(concurrentPlan), (builtPlan) => {
              expect(builtPlan.services[web.name]?.artifact).toEqual({
                kind: "ref",
                ref: "web:test",
                origin: "build",
              });
              expect(builtPlan.services[db.name]?.artifact).toEqual({
                kind: "ref",
                ref: "db:test",
                origin: "build",
              });
              expect(builtPlan.services[cache.name]?.artifact).toEqual({
                kind: "ref",
                ref: "cache:test",
                origin: "build",
              });
            }),
          );
          return yield* Fiber.join(subscriber);
        }),
      ).pipe(Effect.provide(layer(provider))),
    );

    // Then: dispatch order within the bounded pool is not part of the contract.
    expect(calls.sort()).toEqual(["cache", "db", "web"]);
    expect(maxActive).toBe(2);
    expect(
      Array.from(events)
        .map(buildLifecycleEntry)
        .filter((entry) => entry !== undefined),
    ).toEqual(
      expect.arrayContaining([
        ["pre-build", ServiceName.make("web")],
        ["post-build", ServiceName.make("web")],
        ["pre-build", ServiceName.make("db")],
        ["post-build", ServiceName.make("db")],
        ["pre-build", ServiceName.make("cache")],
        ["post-build", ServiceName.make("cache")],
      ]),
    );
  });

  test("publishes transcript-bearing task lifecycle events for real service builds", async () => {
    await withTempUserRoots(async () => {
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.succeed({ providerId, ref: `${spec.service}:test` }),
      };

      const events = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const orchestrator = yield* BuildOrchestrator;
            yield* orchestrator.build(plan);
            return [...(yield* Queue.clear(queue))];
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      const treeStart = events.find((event) => event._tag === "task.tree.start");
      expect(treeStart).toMatchObject({
        parentId: `build-artifact-${String(plan.id)}`,
        children: [String(web.name), String(db.name)],
      });
      const starts = events.filter((event) => event._tag === "task.start");
      expect(starts).toHaveLength(2);
      expect(starts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: String(web.name),
            transcriptPath: expect.stringContaining(
              `${sep}${join("builds", String(plan.id), "artifact", String(web.name))}${sep}`,
            ),
          }),
          expect.objectContaining({
            taskId: String(db.name),
            transcriptPath: expect.stringContaining(
              `${sep}${join("builds", String(plan.id), "artifact", String(db.name))}${sep}`,
            ),
          }),
        ]),
      );
      expect(events.filter((event) => event._tag === "task.complete")).toHaveLength(2);
      expect(events.filter((event) => event._tag === "task.tree.complete")).toHaveLength(1);
    });
  });

  test("settles every artifact task when scratch cache access fails", async () => {
    // Given
    const cacheFailure = new StateStoreError({
      reason: "io",
      operation: "open",
      remediation: "Injected state-store open failure for build orchestrator fixture.",
    });
    const scratchPlan: AppPlan = {
      ...plan,
      id: AppId.make("scratch-cache-failure"),
      extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-cache-failure" } },
      slug: "scratch-cache-failure",
      services: { [web.name]: web, [db.name]: db },
    };
    let cacheOpenCount = 0;
    const failingStateStore = Layer.succeed(
      StateStore,
      StateStore.of({
        withLock: (_key, body) => body,
        open: () => {
          cacheOpenCount += 1;
          return cacheOpenCount === 1 ? Effect.fail(cacheFailure) : Effect.never;
        },
      }),
    );

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const error = yield* Effect.flip(orchestrator.build(scratchPlan));
          return { error, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(layer(TestRuntimeProvider, failingStateStore))),
    );

    // Then
    expect(result.error).toMatchObject({
      _tag: "ProviderInternalError",
      operation: "buildResults",
      cause: cacheFailure,
    });
    expect(result.events.find((event) => event._tag === "task.tree.start")).toMatchObject({
      children: ["web", "db"],
    });
    expect(
      result.events
        .filter((event) => event._tag === "task.fail")
        .map((event) => [event.taskId, event.summary])
        .sort(),
    ).toEqual([
      ["db", "Build db aborted"],
      ["web", "Build web failed"],
    ]);
    expect(
      result.events
        .filter((event) => event._tag === "build-step-skip")
        .map((event) => [event.serviceName, event.reason]),
    ).toEqual([["db", "phase-aborted"]]);
    expect(result.events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
      succeeded: 0,
      failed: 2,
    });
    // A step aborted before dispatch advertises no transcript.
    const abortedStart = result.events.find((event) => event._tag === "task.start" && event.taskId === "db");
    expect(abortedStart?._tag).toBe("task.start");
    if (abortedStart?._tag === "task.start") expect(abortedStart.transcriptPath).toBeUndefined();
  });

  test("preserves the provider failure when recording the scratch failure also fails", async () => {
    // Given
    const providerFailure = new ProviderInternalError({
      providerId: "test",
      operation: "buildArtifact",
      message: "build failed",
      remediation:
        "Re-run the command after checking `test` logs for the `buildArtifact` failure; if it persists, report the error with that operation name.",
    });
    const cacheFailure = new StateStoreError({
      reason: "io",
      operation: "update",
      remediation: "Injected state-store update failure for build orchestrator fixture.",
    });
    const scratchPlan: AppPlan = {
      ...plan,
      id: AppId.make("scratch-cache-write-failure"),
      extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-cache-write-failure" } },
      slug: "scratch-cache-write-failure",
      services: { [web.name]: web },
    };
    const testStore = makeTestStateStore();
    const failingStateStore = Layer.succeed(
      StateStore,
      StateStore.of({
        withLock: testStore.service.withLock,
        open: (spec) =>
          testStore.service.open(spec).pipe(
            Effect.map((bucket) => ({
              ...bucket,
              update: () => Effect.fail(cacheFailure),
            })),
          ),
      }),
    );
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: () => Effect.fail(providerFailure),
    };

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const error = yield* Effect.flip(orchestrator.build(scratchPlan));
          return { error, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(layer(provider, failingStateStore))),
    );

    // Then the provider's own failure stays the outcome; redaction reconstructs its value.
    expect(result.error).toMatchObject({
      _tag: "ProviderInternalError",
      operation: "buildArtifact",
      message: "build failed",
      remediation: providerFailure.remediation,
    });
    expect(result.events.find((event) => event._tag === "task.fail")).toMatchObject({
      taskId: "web",
      summary: "Build web failed",
    });
  });

  test("short-circuits on the original provider failure", async () => {
    const failure = new ProviderInternalError({
      providerId: "test",
      operation: "buildArtifact",
      message: "build failed",
      remediation:
        "Re-run the command after checking `test` logs for the `buildArtifact` failure; if it persists, report the error with that operation name.",
    });
    const calls: string[] = [];
    const siblingStarted = Deferred.makeUnsafe<void>();
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: (spec: ArtifactBuildSpec) => {
        calls.push(String(spec.service));
        return spec.service === ServiceName.make("web")
          ? Deferred.await(siblingStarted).pipe(Effect.andThen(Effect.fail(failure)))
          : Deferred.succeed(siblingStarted, undefined).pipe(
              Effect.as({ providerId, ref: `${spec.service}:test` }),
            );
      },
    };

    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(plan))).pipe(
        Effect.provide(layer(provider)),
      ),
    );

    // The two services begin concurrently; only the failure's value is part of the contract.
    expect(calls.sort()).toEqual(["db", "web"]);
    expect(error).toMatchObject({
      _tag: "ProviderInternalError",
      operation: "buildArtifact",
      message: "build failed",
      remediation: failure.remediation,
    });
  });

  test.each([
    ["parent", true],
    ["companion", false],
  ] as const)(
    "starts a companion build only after its parent build finishes when the %s is listed first",
    async (_first, parentFirst) => {
      // Given a companion cloned from web and a parent build the test holds open.
      const parentStarted = Deferred.makeUnsafe<void>();
      const parentFinished = Deferred.makeUnsafe<void>();
      const releaseParent = Deferred.makeUnsafe<void>();
      const started: string[] = [];
      const companion = companionOf(web);
      const companionPlan: AppPlan = {
        ...plan,
        services: parentFirst
          ? { [web.name]: web, [companion.name]: companion }
          : { [companion.name]: companion, [web.name]: web },
      };
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.gen(function* () {
            if (spec.service === web.name) {
              started.push(String(spec.service));
              yield* Deferred.succeed(parentStarted, undefined);
              yield* Deferred.await(releaseParent);
              yield* Deferred.succeed(parentFinished, undefined);
              return { providerId, ref: `${spec.service}:test` };
            }
            // Then the companion's build only ever starts once the parent's build has finished.
            expect(yield* Deferred.isDone(parentFinished)).toBe(true);
            started.push(String(spec.service));
            return { providerId, ref: `${spec.service}:test` };
          }),
      };

      // When the parent build is held open.
      const builtPlan = await Effect.runPromise(
        Effect.gen(function* () {
          const orchestrator = yield* BuildOrchestrator;
          const fiber = yield* Effect.forkChild(orchestrator.build(companionPlan));
          yield* Deferred.await(parentStarted);
          expect(started).toEqual([String(web.name)]);
          yield* Deferred.succeed(releaseParent, undefined);
          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(layer(provider))),
      );

      // Then both build, the companion after the parent, and the plan keeps its service order.
      expect(started).toEqual([String(web.name), String(companion.name)]);
      expect(Object.keys(builtPlan.services)).toEqual(Object.keys(companionPlan.services));
    },
  );

  test("reports a companion as aborted when its parent build fails", async () => {
    // Given a companion cloned from web and a parent build the test fails.
    const parentStarted = Deferred.makeUnsafe<void>();
    const releaseFailure = Deferred.makeUnsafe<void>();
    const started: string[] = [];
    const failure = new ProviderInternalError({
      providerId: "test",
      operation: "buildArtifact",
      message: "build failed",
      remediation:
        "Re-run the command after checking `test` logs for the `buildArtifact` failure; if it persists, report the error with that operation name.",
    });
    const companion = companionOf(web);
    const companionPlan: AppPlan = {
      ...plan,
      services: { [web.name]: web, [companion.name]: companion },
    };
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: (spec: ArtifactBuildSpec) =>
        spec.service === web.name
          ? Deferred.succeed(parentStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFailure)),
              Effect.andThen(Effect.fail(failure)),
            )
          : Effect.sync(() => {
              started.push(String(spec.service));
              return { providerId, ref: `${spec.service}:test` };
            }),
    };

    // When the parent build fails.
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const fiber = yield* Effect.forkChild(Effect.flip(orchestrator.build(companionPlan)));
          yield* Deferred.await(parentStarted);
          const companionAttempts = [...started];
          yield* Deferred.succeed(releaseFailure, undefined);
          const error = yield* Fiber.join(fiber);
          return { error, companionAttempts, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(layer(provider))),
    );

    // Then the companion never builds and is settled the way an undispatched task is.
    expect(result.companionAttempts).toEqual([]);
    expect(result.error).toMatchObject({
      _tag: "ProviderInternalError",
      operation: "buildArtifact",
      message: "build failed",
    });
    expect(
      result.events
        .filter((event) => event._tag === "task.fail")
        .map((event) => [event.taskId, event.summary])
        .sort(),
    ).toEqual([
      [String(web.name), `Build ${String(web.name)} failed`],
      [String(companion.name), `Build ${String(companion.name)} aborted`],
    ]);
  });

  test.each([
    [undefined, "missing"],
    [{ refresh: true }, "always"],
  ] satisfies ReadonlyArray<readonly [BuildOptions | undefined, ArtifactPullPolicy]>)(
    "acquires ref-only artifacts with options %j and policy %s",
    async (options, policy) => {
      // Given
      const artifactPlan: AppPlan = {
        ...plan,
        services: {
          [web.name]: { ...web, artifact: { kind: "ref", ref: "debian:12.11-slim" } },
        },
      };
      const pulls: ArtifactPullSpec[] = [];
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
        pullArtifact: (spec: ArtifactPullSpec) =>
          Effect.sync(() => {
            pulls.push(spec);
            return { providerId, ref: spec.ref };
          }),
      };

      // When
      const builtPlan = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(artifactPlan, options)).pipe(
          Effect.provide(layer(provider)),
        ),
      );

      // Then
      expect(pulls).toEqual([{ ref: "debian:12.11-slim", policy }]);
      expect(builtPlan.services[web.name]?.artifact).toEqual({ kind: "ref", ref: "debian:12.11-slim" });
    },
  );

  test("rebuild invalidates the derived image key when the base digest moves", async () => {
    const derived: ServicePlan = {
      ...web,
      artifact: { kind: "ref", ref: "php:8.2-apache-bookworm" },
      extensions: {
        "@lando/core/service-features": {
          buildSteps: [
            {
              id: "service-lando.php:prerequisites",
              phase: "build",
              command: "true",
              buildKeyInputs: { aptPackages: { unzip: "1" }, extensions: ["gd"] },
            },
          ],
        },
      },
    };
    const artifactPlan: AppPlan = { ...plan, services: { [web.name]: derived } };
    let baseDigest = "sha256:first";
    const keys: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true, artifactBuild: true },
      pullArtifact: () => Effect.succeed({ providerId, ref: "php:8.2-apache-bookworm", digest: baseDigest }),
      buildArtifact: (spec: ArtifactBuildSpec) =>
        Effect.sync(() => {
          keys.push(spec.buildKey);
          return { providerId, ref: `php-derived:${keys.length}` };
        }),
    };

    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) =>
        Effect.gen(function* () {
          yield* orchestrator.build(artifactPlan);
          baseDigest = "sha256:moved-base";
          yield* orchestrator.build(artifactPlan, { refresh: true });
        }),
      ).pipe(Effect.provide(layer(provider))),
    );

    const firstKey = await Effect.runPromise(
      buildKeyForService(provider, {
        ...derived,
        artifact: { kind: "ref", ref: "php:8.2-apache-bookworm", digest: "sha256:first" },
      }),
    );
    const movedKey = await Effect.runPromise(
      buildKeyForService(provider, {
        ...derived,
        artifact: { kind: "ref", ref: "php:8.2-apache-bookworm", digest: "sha256:moved-base" },
      }),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(firstKey);
    expect(keys[1]).toBe(movedKey);
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("start after rebuild reuses the derived image", async () => {
    await withTempUserRoots(async () => {
      const derived: ServicePlan = {
        ...web,
        artifact: { kind: "ref", ref: "php:8.2-apache-bookworm" },
        extensions: {
          "@lando/core/service-features": {
            buildSteps: [
              {
                id: "service-lando.php:prerequisites",
                phase: "build",
                command: "true",
                buildKeyInputs: { aptPackages: { unzip: "1" }, extensions: ["gd"] },
              },
            ],
          },
        },
      };
      const scratchPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-rebuild-then-start"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-rebuild-then-start" } },
        slug: "scratch-rebuild-then-start",
        services: { [web.name]: derived },
      };
      let baseDigest = "sha256:first";
      const builds: string[] = [];
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true, artifactBuild: true },
        pullArtifact: () =>
          Effect.succeed({ providerId, ref: "php:8.2-apache-bookworm", digest: baseDigest }),
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.sync(() => {
            builds.push(spec.buildKey);
            return {
              providerId,
              ref: `php-derived:${builds.length}`,
              digest: `sha256:derived-${builds.length}`,
            };
          }),
      };

      const result = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            const first = yield* orchestrator.build(scratchPlan);
            baseDigest = "sha256:second";
            const rebuilt = yield* orchestrator.build(scratchPlan, { refresh: true });
            const started = yield* orchestrator.build(scratchPlan);
            return { first, rebuilt, started };
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      expect(builds).toHaveLength(2);
      expect(result.started.services[web.name]?.artifact).toEqual(
        result.rebuilt.services[web.name]?.artifact,
      );
      expect(result.rebuilt.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:2",
        digest: "sha256:derived-2",
        origin: "build",
      });
      expect(result.first.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:1",
        digest: "sha256:derived-1",
        origin: "build",
      });
    });
  });

  test("rebuild builds under the start build key when refresh falls back to the local base", async () => {
    await withTempUserRoots(async () => {
      const derived: ServicePlan = {
        ...web,
        artifact: { kind: "ref", ref: "php:8.2-apache-bookworm" },
        extensions: {
          "@lando/core/service-features": {
            buildSteps: [
              {
                id: "service-lando.php:prerequisites",
                phase: "build",
                command: "true",
                buildKeyInputs: { aptPackages: { unzip: "1" }, extensions: ["gd"] },
              },
            ],
          },
        },
      };
      const scratchPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-refresh-offline"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-refresh-offline" } },
        slug: "scratch-refresh-offline",
        services: { [web.name]: derived },
      };
      const failure = new ProviderInternalError({
        providerId: "test",
        operation: "pullArtifact",
        message: "registry unavailable",
        remediation: "Retry when the registry is reachable.",
      });
      let refreshing = false;
      const builds: string[] = [];
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true, artifactBuild: true },
        pullArtifact: (spec: ArtifactPullSpec) => {
          if (refreshing && spec.policy !== "never") return Effect.fail(failure);
          return Effect.succeed({ providerId, ref: spec.ref, digest: "sha256:local" });
        },
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.sync(() => {
            builds.push(spec.buildKey);
            return { providerId, ref: `php-derived:${builds.length}`, digest: "sha256:derived-1" };
          }),
      };
      const commandWarnings = makeCommandWarnings(true);

      const result = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            const first = yield* orchestrator.build(scratchPlan);
            refreshing = true;
            const rebuilt = yield* orchestrator.build(scratchPlan, { refresh: true });
            return { first, rebuilt, warnings: yield* commandWarnings.list };
          }),
        ).pipe(Effect.provideService(CommandWarnings, commandWarnings), Effect.provide(layer(provider))),
      );

      // A rebuild always dispatches; the local fallback resolves the same base, so the key is unchanged.
      expect(builds).toHaveLength(2);
      expect(builds[1]).toBe(builds[0]);
      expect(result.first.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:1",
        digest: "sha256:derived-1",
        origin: "build",
      });
      expect(result.rebuilt.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:2",
        digest: "sha256:derived-1",
        origin: "build",
      });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]?.code).toBe("LANDO_ARTIFACT_REFRESH_FAILED");
    });
  });

  test("uses the local artifact and publishes one redacted warning when refresh fails", async () => {
    // Given
    const ref = "debian:12.11-slim";
    const artifactPlan: AppPlan = {
      ...plan,
      services: { [web.name]: { ...web, artifact: { kind: "ref", ref } } },
    };
    const failure = new ProviderInternalError({
      providerId: "test",
      operation: "pullArtifact",
      message: "registry unavailable topsecret",
      remediation:
        "Re-run the command after checking `test` logs for the `pullArtifact` failure; if it persists, report the error with that operation name.",
    });
    const pulls: ArtifactPullSpec[] = [];
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: ArtifactPullSpec) => {
        pulls.push(spec);
        return spec.policy === "never"
          ? Effect.succeed({ providerId, ref, digest: "sha256:local" })
          : Effect.fail(failure);
      },
    };

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const builder = yield* BuildOrchestrator;
          const built = yield* builder.build(artifactPlan, { refresh: true });
          return { built, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(layerWithRedaction(provider, redactionLayer))),
    );

    // Then
    expect(result.built.services[web.name]?.artifact).toEqual({ kind: "ref", ref, digest: "sha256:local" });
    expect(pulls).toEqual([
      { ref, policy: "always" },
      { ref, policy: "never" },
    ]);
    const warnings = result.events.filter((event) => event._tag === "message.warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain(ref);
    expect(warnings[0]?.body).toContain(web.name);
    expect(warnings[0]?.body).not.toContain("topsecret");
    expect(DateTime.isDateTime(warnings[0]?.timestamp)).toBe(true);
  });

  test("records a structured warning instead of a message event for machine output", async () => {
    // Given
    const ref = "debian:12.11-slim";
    const artifactPlan: AppPlan = {
      ...plan,
      services: { [web.name]: { ...web, artifact: { kind: "ref", ref } } },
    };
    const failure = new ProviderInternalError({
      providerId: "test",
      operation: "pullArtifact",
      message: "registry unavailable topsecret",
      remediation:
        "Re-run the command after checking `test` logs for the `pullArtifact` failure; if it persists, report the error with that operation name.",
    });
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: ArtifactPullSpec) =>
        spec.policy === "never" ? Effect.succeed({ providerId, ref }) : Effect.fail(failure),
    };
    const commandWarnings = makeCommandWarnings(true);

    // When
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const builder = yield* BuildOrchestrator;
          yield* builder.build(artifactPlan, { refresh: true });
          return [...(yield* Queue.clear(queue))];
        }),
      ).pipe(
        Effect.provideService(CommandWarnings, commandWarnings),
        Effect.provide(layerWithRedaction(provider, redactionLayer)),
      ),
    );

    // Then
    const warnings = await Effect.runPromise(commandWarnings.list);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "LANDO_ARTIFACT_REFRESH_FAILED",
      context: { service: web.name, artifact: ref, cause: "ProviderInternalError" },
    });
    expect(warnings[0]?.message).not.toContain("topsecret");
    expect(events.filter((event) => event._tag === "message.warn")).toEqual([]);
  });

  test.each([false, true])("preserves the pull failure for refresh=%s", async (refresh) => {
    // Given
    const ref = "debian:12.11-slim";
    const artifactPlan: AppPlan = {
      ...plan,
      services: { [web.name]: { ...web, artifact: { kind: "ref", ref } } },
    };
    const failure = new ProviderInternalError({
      providerId: "test",
      operation: "pullArtifact",
      message: "registry unavailable",
      remediation:
        "Re-run the command after checking `test` logs for the `pullArtifact` failure; if it persists, report the error with that operation name.",
    });
    const localFailure = new ProviderInternalError({
      providerId: "test",
      operation: "pullArtifact",
      message: "local copy missing",
      remediation:
        "Re-run the command after checking `test` logs for the `pullArtifact` failure; if it persists, report the error with that operation name.",
    });
    const pulls: ArtifactPullSpec[] = [];
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: ArtifactPullSpec) => {
        pulls.push(spec);
        return Effect.fail(spec.policy === "never" ? localFailure : failure);
      },
    };

    // When
    const error = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (builder) =>
        builder.build(artifactPlan, refresh ? { refresh: true } : undefined),
      ).pipe(Effect.flip, Effect.provide(layer(provider))),
    );

    // Then
    expect(error).toBe(failure);
    expect(pulls).toEqual(
      refresh
        ? [
            { ref, policy: "always" },
            { ref, policy: "never" },
          ]
        : [{ ref, policy: "missing" }],
    );
  });

  test.each(["defect", "interrupt"] as const)("propagates refresh %s", async (kind) => {
    // Given
    const ref = "debian:12.11-slim";
    const artifactPlan: AppPlan = {
      ...plan,
      services: { [web.name]: { ...web, artifact: { kind: "ref", ref } } },
    };
    const pulls: ArtifactPullSpec[] = [];
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: ArtifactPullSpec) => {
        pulls.push(spec);
        return kind === "defect" ? Effect.die("pull defect") : Effect.interrupt;
      },
    };

    // When
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(BuildOrchestrator, (builder) => builder.build(artifactPlan, { refresh: true })).pipe(
        Effect.provide(layer(provider)),
      ),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(kind === "defect" ? Cause.hasDies(exit.cause) : Cause.hasInterrupts(exit.cause)).toBe(true);
    }
    expect(pulls).toEqual([{ ref, policy: "always" }]);
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
            .pipe(Stream.filter((event) => buildLifecycleEntry(event) !== undefined))
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
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
    const envRedactionLayer = Layer.succeed(
      RedactionService,
      RedactionService.of({
        ...makeRedactionService(),
        payloadValues: (options) =>
          Effect.succeed(() => ({ substring: [options?.sourceEnv?.BUN_AUTH_TOKEN ?? ""], wholeToken: [] })),
        forProfile: (_profile, options) =>
          Effect.succeed(createRedactor("secrets", { values: [options?.sourceEnv?.BUN_AUTH_TOKEN ?? ""] })),
      } satisfies Context.Service.Shape<typeof RedactionService>),
    );

    try {
      const events = await Effect.runPromise(
        Effect.flatMap(EventService, (eventService) =>
          Effect.gen(function* () {
            const subscriber = yield* eventService
              .subscribe("*")
              .pipe(Stream.filter((event) => buildLifecycleEntry(event) !== undefined))
              .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
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
    const lazyRedactionLayer = Layer.succeed(
      RedactionService,
      RedactionService.of({
        ...makeRedactionService(),
        payloadValues: () => Effect.succeed(() => ({ substring: ["latersecret"], wholeToken: [] })),
        forProfile: () =>
          Effect.sync(() => {
            profileReads += 1;
            return createRedactor("secrets", { values: ["latersecret"] });
          }),
      }),
    );

    const events = await Effect.runPromise(
      Effect.flatMap(EventService, (eventService) =>
        Effect.gen(function* () {
          const orchestrator = yield* BuildOrchestrator;
          expect(profileReads).toBe(0);
          const subscriber = yield* eventService
            .subscribe("*")
            .pipe(Stream.filter((event) => buildLifecycleEntry(event) !== undefined))
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
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
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-toolbox-first" } },
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
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-toolbox-second" } },
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
            return { providerId, ref: spec.ref, digest: "sha256:current" };
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
              digest: "sha256:current",
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
      expect(pullCalls).toEqual(["debian:12.11-slim", "debian:12.11-slim"]);
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
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-digest-first" } },
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
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-digest-second" } },
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
      expect(pullCalls).toEqual(["debian:12.11-slim", "debian:12.11-slim"]);
    });
  });

  test("rebuilds a warm scratch artifact when its mutable base image digest changes", async () => {
    await withTempUserRoots(async () => {
      // Given
      const derivedService: ServicePlan = {
        ...web,
        artifact: { kind: "ref", ref: "php:8.4-apache-bookworm" },
        extensions: {
          "@lando/core/service-features": {
            buildSteps: [{ id: "php-extension", phase: "build", command: ["echo", "build"] }],
          },
        },
      };
      const firstPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-base-digest-first"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-base-digest-first" } },
        slug: "scratch-base-digest-first",
        services: { [web.name]: derivedService },
      };
      const repeatPlan: AppPlan = {
        ...firstPlan,
        id: AppId.make("scratch-base-digest-second"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-base-digest-second" } },
        slug: "scratch-base-digest-second",
      };
      let baseDigest = "sha256:first";
      let builds = 0;
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
        pullArtifact: (spec: { readonly ref: string }) =>
          Effect.succeed({ providerId, ref: spec.ref, digest: baseDigest }),
        buildArtifact: () =>
          Effect.sync(() => {
            builds += 1;
            return { providerId, ref: `php-derived:${builds}`, digest: `sha256:derived-${builds}` };
          }),
      };

      // When
      const builtRepeat = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(firstPlan);
            baseDigest = "sha256:second";
            return yield* orchestrator.build(repeatPlan);
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then
      expect(builds).toBe(2);
      expect(builtRepeat.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:2",
        digest: "sha256:derived-2",
        origin: "build",
      });
    });
  });

  test("marks only an artifact the provider built as produced", async () => {
    // Given a derived service the provider builds and a source-only service it merely acquires.
    const derived: ServicePlan = {
      ...web,
      artifact: { kind: "ref", ref: "php:8.4-apache-bookworm" },
      extensions: {
        "@lando/core/service-features": {
          buildSteps: [{ id: "php-extension", phase: "build", command: ["echo", "build"] }],
        },
      },
    };
    const sourceOnly: ServicePlan = { ...db, artifact: { kind: "ref", ref: "postgres:17" } };
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: ArtifactPullSpec) =>
        Effect.succeed({ providerId, ref: spec.ref, digest: `sha256:${spec.ref.length}` }),
      buildArtifact: () => Effect.succeed({ providerId, ref: "lando-build-test-web-key" }),
    };

    // When
    const built = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) =>
        orchestrator.build({ ...plan, services: { [web.name]: derived, [db.name]: sourceOnly } }),
      ).pipe(Effect.provide(layer(provider))),
    );

    // Then
    expect(built.services[web.name]?.artifact).toEqual({
      kind: "ref",
      ref: "lando-build-test-web-key",
      origin: "build",
    });
    expect(built.services[db.name]?.artifact).toEqual({
      kind: "ref",
      ref: "postgres:17",
      digest: "sha256:11",
    });
  });

  test.each([
    ["reuses a scratch build whose produced image is still present", true, 1],
    ["rebuilds a scratch build whose produced image is gone", false, 2],
  ] as const)("%s", async (_label, imageRetained, expectedBuilds) => {
    await withTempUserRoots(async () => {
      // Given a recorded scratch build of a derived image.
      const derived: ServicePlan = {
        ...web,
        artifact: { kind: "ref", ref: "php:8.4-apache-bookworm" },
        extensions: {
          "@lando/core/service-features": {
            buildSteps: [{ id: "php-extension", phase: "build", command: ["echo", "build"] }],
          },
        },
      };
      const firstPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-produced-first"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-produced-first" } },
        slug: "scratch-produced-first",
        services: { [web.name]: derived },
      };
      const repeatPlan: AppPlan = {
        ...firstPlan,
        id: AppId.make("scratch-produced-second"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-produced-second" } },
        slug: "scratch-produced-second",
      };
      const localImages = new Set<string>();
      const localLookups: string[] = [];
      let builds = 0;
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
        pullArtifact: (spec: ArtifactPullSpec) => {
          if (spec.policy !== "never")
            return Effect.succeed({ providerId, ref: spec.ref, digest: "sha256:base" });
          localLookups.push(spec.ref);
          return localImages.has(spec.ref)
            ? Effect.succeed({ providerId, ref: spec.ref })
            : Effect.fail(
                new ProviderUnavailableError({
                  providerId: "test",
                  operation: "pullArtifact",
                  message: `Container image ${spec.ref} is not present locally.`,
                  remediation: "Rebuild it.",
                }),
              );
        },
        buildArtifact: () =>
          Effect.sync(() => {
            builds += 1;
            const ref = `php-derived:${builds}`;
            localImages.add(ref);
            return { providerId, ref };
          }),
      };

      // When the produced image is kept or removed before the same build runs again.
      const builtRepeat = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(firstPlan);
            if (!imageRetained) localImages.clear();
            return yield* orchestrator.build(repeatPlan);
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then the cache hit is honored only for an image that still exists, and stays marked produced.
      expect(builds).toBe(expectedBuilds);
      expect(localLookups).toEqual(["php-derived:1"]);
      expect(builtRepeat.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: `php-derived:${expectedBuilds}`,
        origin: "build",
      });
    });
  });

  test("falls back to planned digest for legacy warm scratch cache hits with the same artifact ref", async () => {
    await withTempUserRoots(async () => {
      const artifactPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-legacy-digest"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-legacy-digest" } },
        slug: "scratch-legacy-digest",
        root: AbsolutePath.make("/tmp/scratch-legacy-digest/root"),
        services: {
          [web.name]: {
            ...web,
            artifact: { kind: "ref", ref: "debian:12.11-slim", digest: "sha256:planned" },
          },
        },
      };
      const provider = {
        ...TestRuntimeProvider,
        pullArtifact: () => Effect.die("legacy cache hit should not pull artifacts"),
      };

      const builtPlan = await Effect.runPromise(
        Effect.gen(function* () {
          const stateStore = yield* StateStore;
          const buildKey = yield* buildKeyForService(provider, artifactPlan.services[web.name] ?? web);
          const bucket = yield* openScratchBuildResults(stateStore);
          yield* recordBuildResult(bucket, {
            buildKey,
            service: web.name,
            phase: "artifact",
            outcome: "complete",
            exitCode: 0,
            durationMs: 1,
            artifactRef: "debian:12.11-slim",
            transcriptPath: AbsolutePath.make("/tmp/legacy-scratch-build.log"),
          });
          const orchestrator = yield* BuildOrchestrator;
          return yield* orchestrator.build(artifactPlan);
        }).pipe(Effect.provide(layer(provider))),
      );

      expect(builtPlan.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "debian:12.11-slim",
        digest: "sha256:planned",
      });
    });
  });

  test("replaces a legacy warm scratch cache entry whose artifact identity is incomplete", async () => {
    await withTempUserRoots(async () => {
      const artifactPlan: AppPlan = {
        ...plan,
        id: AppId.make("scratch-legacy-different-ref"),
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-legacy-different-ref" } },
        slug: "scratch-legacy-different-ref",
        root: AbsolutePath.make("/tmp/scratch-legacy-different-ref/root"),
        services: {
          [web.name]: {
            ...web,
            artifact: { kind: "ref", ref: "debian:12.11-slim", digest: "sha256:planned" },
          },
        },
      };
      const provider = {
        ...TestRuntimeProvider,
        pullArtifact: () => Effect.die("legacy cache hit should not pull artifacts"),
      };

      const builtPlan = await Effect.runPromise(
        Effect.gen(function* () {
          const stateStore = yield* StateStore;
          const buildKey = yield* buildKeyForService(provider, artifactPlan.services[web.name] ?? web);
          const bucket = yield* openScratchBuildResults(stateStore);
          yield* recordBuildResult(bucket, {
            buildKey,
            service: web.name,
            phase: "artifact",
            outcome: "complete",
            exitCode: 0,
            durationMs: 1,
            artifactRef: "ubuntu:24.04",
            transcriptPath: AbsolutePath.make("/tmp/legacy-scratch-different-ref-build.log"),
          });
          const orchestrator = yield* BuildOrchestrator;
          return yield* orchestrator.build(artifactPlan);
        }).pipe(Effect.provide(layer(provider))),
      );

      expect(builtPlan.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "debian:12.11-slim",
        digest: "sha256:planned",
      });
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
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-toolbox-redirect-first" } },
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
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-toolbox-redirect-second" } },
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
        remediation:
          "Re-run the command after checking `test` logs for the `pullArtifact` failure; if it persists, report the error with that operation name.",
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
            yield* Effect.result(orchestrator.build(planWithRedirect("/logs/failure.log")));
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

  const derivedService = (
    overrides: Partial<Pick<ServicePlan, "environment" | "pullPolicy">> = {},
  ): ServicePlan => ({
    ...web,
    artifact: { kind: "ref", ref: "php:8.4-apache-bookworm" },
    extensions: {
      "@lando/core/service-features": {
        buildSteps: [{ id: "php-extension", phase: "build", command: ["echo", "build"] }],
      },
    },
    ...overrides,
  });

  const derivedProvider = () => {
    const calls = { builds: 0 };
    const provider = {
      ...TestRuntimeProvider,
      capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
      pullArtifact: (spec: ArtifactPullSpec) =>
        spec.policy === "never"
          ? Effect.succeed({ providerId, ref: spec.ref })
          : Effect.succeed({ providerId, ref: spec.ref, digest: "sha256:base" }),
      buildArtifact: () =>
        Effect.sync(() => {
          calls.builds += 1;
          return {
            providerId,
            ref: `php-derived:${calls.builds}`,
            digest: `sha256:derived-${calls.builds}`,
          };
        }),
    };
    return { provider, calls };
  };

  const buildTwice = (provider: RuntimeProviderShape, buildPlan: AppPlan, options?: BuildOptions) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const first = yield* orchestrator.build(buildPlan);
          const firstEvents = [...(yield* Queue.clear(queue))];
          const second = yield* orchestrator.build(buildPlan, options);
          return { first, second, firstEvents, secondEvents: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(layer(provider))),
    );

  test("writes redacted build output to the transcript and publishes task detail", async () => {
    await withTempUserRoots(async () => {
      // Given a build step whose output prints a plan secret.
      const context = await mkdtemp(join(makeLandoPaths().roots.userDataRoot, "build-output-context-"));
      await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
      const built: ServicePlan = {
        ...web,
        artifact: {
          kind: "build",
          context: AbsolutePath.make(context),
          contentHash: "sha256:context",
        },
        environment: { DB_PASSWORD: "build-output-secret" },
        extensions: {
          "@lando/core/service-features": {
            buildSteps: [{ id: "image", phase: "build", command: ["echo", "build"] }],
          },
        },
      };
      const buildPlan: AppPlan = { ...plan, services: { [built.name]: built } };
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          (spec.onOutput === undefined
            ? Effect.die("onOutput was not supplied")
            : spec.onOutput("Step 1: build-output-secret\n")
          ).pipe(Effect.as({ providerId, ref: "built:web" })),
      };

      // When
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const orchestrator = yield* BuildOrchestrator;
            yield* orchestrator.build(buildPlan);
            return [...(yield* Queue.clear(queue))];
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then
      const start = result.find((event) => event._tag === "task.start");
      if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
      const transcript = await readFile(String(start.transcriptPath), "utf8");
      expect(transcript).toContain("Step 1: [redacted]");
      expect(transcript).not.toContain("build-output-secret");
      const details = result.filter((event) => event._tag === "task.detail");
      expect(details).toHaveLength(1);
      expect(details[0]?.line).toBe("Step 1: [redacted]");
    });
  });

  test("rebuilds an artifact build failure with service, transcript path, and output tail", async () => {
    await withTempUserRoots(async () => {
      // Given a build that prints two lines and then fails.
      const context = await mkdtemp(join(makeLandoPaths().roots.userDataRoot, "build-failure-context-"));
      await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
      const built: ServicePlan = {
        ...web,
        artifact: {
          kind: "build",
          context: AbsolutePath.make(context),
          contentHash: "sha256:context",
        },
        extensions: {
          "@lando/core/service-features": {
            buildSteps: [{ id: "image", phase: "build", command: ["echo", "build"] }],
          },
        },
      };
      const providerFailure = new ArtifactBuildError({
        providerId: "test",
        operation: "buildArtifact",
        message: "step failed",
        remediation: "Fix the failing build step.",
      });
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          (spec.onOutput === undefined
            ? Effect.die("onOutput was not supplied")
            : spec.onOutput("first line\nsecond line\n")
          ).pipe(Effect.andThen(Effect.fail(providerFailure))),
      };

      // When
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.flatMap(BuildOrchestrator, (orchestrator) =>
            orchestrator.build({ ...plan, services: { [built.name]: built } }),
          ),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then
      expect(error._tag).toBe("ArtifactBuildError");
      if (error._tag !== "ArtifactBuildError") throw error;
      expect(error).not.toBe(providerFailure);
      expect(error.message).toBe("step failed");
      expect(error.service).toBe("web");
      expect(error.outputTail).toContain("first line");
      expect(error.outputTail).toContain("second line");
      expect(error.transcriptPath).toBeDefined();
      expect(error.remediation).toContain("Fix the failing build step.");
      expect(error.remediation).toContain(String(error.transcriptPath));
      expect(error.remediation).toEndWith('Run "lando logs --build --service web" to print it.');
      const transcript = await readFile(String(error.transcriptPath), "utf8");
      expect(transcript).toContain("first line\nsecond line\n");
      expect(transcript).toContain("Error: step failed");
    });
  });

  test("writes the acquired image reference for an acquisition-only step", async () => {
    await withTempUserRoots(async () => {
      // Given a ref-only service the provider merely acquires.
      const artifactPlan: AppPlan = {
        ...plan,
        services: { [web.name]: { ...web, artifact: { kind: "ref", ref: "debian:12.11-slim" } } },
      };
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
        pullArtifact: () =>
          Effect.succeed({ providerId, ref: "debian:12.11-slim", digest: "sha256:acquired" }),
      };

      // When
      const events = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const orchestrator = yield* BuildOrchestrator;
            yield* orchestrator.build(artifactPlan);
            return [...(yield* Queue.clear(queue))];
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then
      const start = events.find((event) => event._tag === "task.start");
      if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
      expect(await readFile(String(start.transcriptPath), "utf8")).toBe(
        "Using image debian:12.11-slim@sha256:acquired\n",
      );
    });
  });

  const expectCachedStepTranscript = async (appId: string, transcriptExists: boolean) => {
    await withTempUserRoots(async () => {
      // Given a warm scratch result whose recorded transcript may or may not still exist.
      const scratchPlan: AppPlan = {
        ...plan,
        id: AppId.make(appId),
        slug: appId,
        extensions: { [SCRATCH_EXTENSION_KEY]: { id: appId } },
        services: {
          [web.name]: {
            ...web,
            artifact: { kind: "ref", ref: "debian:12.11-slim", digest: "sha256:planned" },
          },
        },
      };
      const buildsDir = join(makeLandoPaths().roots.userDataRoot, "builds", appId);
      const recorded = AbsolutePath.make(join(buildsDir, "image.log"));
      if (transcriptExists) {
        await mkdir(buildsDir, { recursive: true });
        await writeFile(recorded, "recorded output\n");
      }
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: () => Effect.die("a cached step must not build"),
      };

      // When
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const stateStore = yield* StateStore;
            const buildKey = yield* buildKeyForService(provider, scratchPlan.services[web.name] ?? web);
            const bucket = yield* openScratchBuildResults(stateStore);
            yield* recordBuildResult(bucket, {
              buildKey,
              service: web.name,
              phase: "artifact",
              outcome: "complete",
              exitCode: 0,
              durationMs: 1,
              artifactRef: "debian:12.11-slim",
              sourceArtifactRef: "debian:12.11-slim",
              sourceArtifactDigest: "sha256:planned",
              transcriptPath: recorded,
            });
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const orchestrator = yield* BuildOrchestrator;
            yield* orchestrator.build(scratchPlan);
            return [...(yield* Queue.clear(queue))];
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then
      const start = result.find((event) => event._tag === "task.start");
      if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
      expect(start.transcriptPath).toBe(transcriptExists ? recorded : undefined);
      expect(result.find((event) => event._tag === "build-step-skip")).toMatchObject({ cached: true });
    });
  };

  test("a cached step advertises its recorded transcript and dispatches nothing", async () => {
    await expectCachedStepTranscript("scratch-recorded-transcript", true);
  });

  test("a cached step whose transcript is gone advertises none and still reuses the result", async () => {
    await expectCachedStepTranscript("scratch-missing-transcript", false);
  });

  test("sweeps unreferenced artifact transcripts after a successful phase", async () => {
    await withTempUserRoots(async () => {
      // Given a phase directory left with a stale file and an orphaned service directory.
      const phase = join(makeLandoPaths().roots.userDataRoot, "builds", String(plan.id), "artifact");
      await mkdir(join(phase, "web"), { recursive: true });
      await mkdir(join(phase, "ghost"), { recursive: true });
      await writeFile(join(phase, "web", "stale.log"), "stale\n");
      await writeFile(join(phase, "ghost", "stale.log"), "stale\n");
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.succeed({ providerId, ref: `${spec.service}:test` }),
      };

      // When
      await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(plan)).pipe(
          Effect.provide(layer(provider)),
        ),
      );

      // Then the transcript the build just recorded stays and everything else goes.
      expect(await Bun.file(join(phase, "web", "stale.log")).exists()).toBe(false);
      const webFiles = await readdir(join(phase, "web"));
      expect(webFiles).toHaveLength(1);
      expect(webFiles[0]).toEndWith(".log");
      await expect(access(join(phase, "ghost"))).rejects.toThrow();
    });
  });

  test("keeps unreferenced artifact transcripts when the phase fails", async () => {
    await withTempUserRoots(async () => {
      // Given a stale transcript and a build that fails.
      const phase = join(makeLandoPaths().roots.userDataRoot, "builds", String(plan.id), "artifact");
      await mkdir(join(phase, "web"), { recursive: true });
      const stale = join(phase, "web", "stale.log");
      await writeFile(stale, "stale\n");
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: () =>
          Effect.fail(
            new ArtifactBuildError({
              providerId: "test",
              operation: "buildArtifact",
              message: "step failed",
              remediation: "Fix the failing build step.",
            }),
          ),
      };

      // When
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(plan)).pipe(
          Effect.provide(layer(provider)),
        ),
      );

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      expect(await Bun.file(stale).exists()).toBe(true);
    });
  });

  test("keeps unreferenced artifact transcripts when every step is reused", async () => {
    await withTempUserRoots(async () => {
      // Given a phase that first succeeds and then runs fully from its recorded results.
      const phase = join(makeLandoPaths().roots.userDataRoot, "builds", String(plan.id), "artifact");
      const stale = join(phase, "web", "stale.log");
      let builds = 0;
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.sync(() => {
            builds += 1;
            return { providerId, ref: `${spec.service}:test` };
          }),
      };

      // When
      await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(plan);
            yield* Effect.promise(() => mkdir(join(phase, "web"), { recursive: true }));
            yield* Effect.promise(() => writeFile(stale, "stale\n"));
            yield* orchestrator.build(plan);
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then
      expect(builds).toBe(2);
      expect(await Bun.file(stale).exists()).toBe(true);
    });
  });

  test("keeps the path-only build failure remediation for the global app", async () => {
    await withTempUserRoots(async () => {
      // Given a failing build of the global app.
      const context = await mkdtemp(join(makeLandoPaths().roots.userDataRoot, "global-failure-context-"));
      await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
      const globalPlan: AppPlan = {
        ...plan,
        id: AppId.make("global"),
        slug: "global",
        services: {
          [web.name]: {
            ...web,
            artifact: {
              kind: "build",
              context: AbsolutePath.make(context),
              contentHash: "sha256:context",
            },
          },
        },
      };
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: () =>
          Effect.fail(
            new ArtifactBuildError({
              providerId: "test",
              operation: "buildArtifact",
              message: "step failed",
              remediation: "Fix the failing build step.",
            }),
          ),
      };

      // When
      const error = await Effect.runPromise(
        Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(globalPlan))).pipe(
          Effect.provide(layer(provider)),
        ),
      );

      // Then
      expect(error._tag).toBe("ArtifactBuildError");
      if (error._tag !== "ArtifactBuildError") throw error;
      expect(error.remediation).toEndWith(
        `The full build output for service web is in ${String(error.transcriptPath)}.`,
      );
      expect(error.remediation).not.toContain("lando logs --build");
      expect(error.remediation).toBe(error.remediation.trimEnd());
    });
  });

  test("reuses a recorded user artifact build without dispatching provider work", async () => {
    await withTempUserRoots(async () => {
      // Given a user app whose derived artifact build succeeded once.
      const derived = derivedService();
      const buildPlan: AppPlan = { ...plan, services: { [web.name]: derived } };
      const { provider, calls } = derivedProvider();

      // When the same plan builds against one state store twice.
      const run = await buildTwice(provider, buildPlan);

      // Then the second build returns the recorded result and advertises its transcript.
      expect(calls.builds).toBe(1);
      expect(run.second).toEqual(run.first);
      expect(run.second.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:1",
        digest: "sha256:derived-1",
        origin: "build",
      });
      expect(run.secondEvents.filter((event) => event._tag === "task.detail")).toEqual([]);
      expect(run.secondEvents.find((event) => event._tag === "build-step-skip")).toMatchObject({
        cached: true,
        reason: "up-to-date",
        phase: "artifact",
        serviceName: ServiceName.make("web"),
      });
      expect(
        run.secondEvents.filter((event) => event._tag === "pre-build" || event._tag === "post-build"),
      ).toEqual([]);
      const firstStart = run.firstEvents.find((event) => event._tag === "task.start");
      const secondStart = run.secondEvents.find((event) => event._tag === "task.start");
      if (firstStart?._tag !== "task.start" || secondStart?._tag !== "task.start")
        throw new TypeError("task start event is missing");
      expect(secondStart.transcriptPath).toBe(firstStart.transcriptPath);
    });
  });

  test("dispatches a recorded user artifact build again when refresh is requested", async () => {
    await withTempUserRoots(async () => {
      // Given a user app whose derived artifact build succeeded once.
      const derived = derivedService();
      const buildPlan: AppPlan = { ...plan, services: { [web.name]: derived } };
      const { provider, calls } = derivedProvider();

      // When the second build requests a refresh.
      const { second } = await buildTwice(provider, buildPlan, { refresh: true });

      // Then the provider builds again.
      expect(calls.builds).toBe(2);
      expect(second.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:2",
        digest: "sha256:derived-2",
        origin: "build",
      });
    });
  });

  test("dispatches a recorded user artifact build again for pull policy build", async () => {
    await withTempUserRoots(async () => {
      // Given a user app whose derived artifact declares pull_policy: build.
      const derived = derivedService({ pullPolicy: "build" });
      const buildPlan: AppPlan = { ...plan, services: { [web.name]: derived } };
      const { provider, calls } = derivedProvider();

      // When the same plan builds twice.
      const { second } = await buildTwice(provider, buildPlan);

      // Then pull_policy: build dispatches the build again.
      expect(calls.builds).toBe(2);
      expect(second.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:2",
        digest: "sha256:derived-2",
        origin: "build",
      });
    });
  });

  test("dispatches a recorded user artifact build again when its produced image is gone", async () => {
    await withTempUserRoots(async () => {
      // Given a user app whose produced image is removed after the first build.
      const derived = derivedService();
      const buildPlan: AppPlan = { ...plan, services: { [web.name]: derived } };
      const { provider: availableProvider, calls } = derivedProvider();
      let producedPresent = true;
      const provider = {
        ...availableProvider,
        pullArtifact: (spec: ArtifactPullSpec) => {
          if (spec.policy === "never" && spec.ref.startsWith("php-derived:") && !producedPresent) {
            return Effect.fail(
              new ProviderUnavailableError({
                providerId: "test",
                operation: "pullArtifact",
                message: `Container image ${spec.ref} is not present locally.`,
                remediation: "Rebuild it.",
              }),
            );
          }
          return availableProvider.pullArtifact(spec);
        },
      };

      // When the produced image is gone before the second build.
      const second = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(buildPlan);
            producedPresent = false;
            return yield* orchestrator.build(buildPlan);
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then the missing image turns the recorded result into a miss.
      expect(calls.builds).toBe(2);
      expect(second.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:2",
        digest: "sha256:derived-2",
        origin: "build",
      });
    });
  });

  test("a failed user artifact build does not suppress the next build", async () => {
    await withTempUserRoots(async () => {
      // Given a user app whose first build fails.
      const derived = derivedService();
      const buildPlan: AppPlan = { ...plan, services: { [web.name]: derived } };
      const failure = new ProviderInternalError({
        providerId: "test",
        operation: "buildArtifact",
        message: "first build failed",
        remediation: "Fix the failing build step.",
      });
      let builds = 0;
      const provider = {
        ...derivedProvider().provider,
        buildArtifact: () => {
          builds += 1;
          const attempt = builds;
          return attempt === 1
            ? Effect.fail(failure)
            : Effect.succeed({
                providerId,
                ref: `php-derived:${attempt}`,
                digest: `sha256:derived-${attempt}`,
              });
        },
      };

      // When the same plan builds again after the failure.
      const run = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            const first = yield* Effect.result(orchestrator.build(buildPlan));
            const second = yield* orchestrator.build(buildPlan);
            return { first, second };
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then the failed attempt is not reused.
      expect(run.first._tag).toBe("Failure");
      expect(builds).toBe(2);
      expect(run.second.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:2",
        digest: "sha256:derived-2",
        origin: "build",
      });
    });
  });

  test("reuses a recorded user acquisition-only result without re-running the provider build", async () => {
    await withTempUserRoots(async () => {
      // Given a user app whose acquisition-only step resolved an image digest.
      const acquired: ServicePlan = { ...web, artifact: { kind: "ref", ref: "debian:12.11-slim" } };
      const buildPlan: AppPlan = { ...plan, services: { [web.name]: acquired } };
      const provider = {
        ...TestRuntimeProvider,
        capabilities: { ...TestRuntimeProvider.capabilities, artifactPull: true },
        pullArtifact: (spec: ArtifactPullSpec) =>
          Effect.succeed({ providerId, ref: spec.ref, digest: "sha256:acquired" }),
        buildArtifact: () => Effect.die("an acquisition-only step must not build"),
      };

      // When the same plan builds twice against one state store.
      const run = await buildTwice(provider, buildPlan);

      // Then the recorded digest is reused.
      expect(run.second).toEqual(run.first);
      expect(run.second.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "debian:12.11-slim",
        digest: "sha256:acquired",
      });
      expect(run.secondEvents.find((event) => event._tag === "build-step-skip")).toMatchObject({
        cached: true,
        reason: "up-to-date",
        phase: "artifact",
      });
      expect(
        run.secondEvents.filter((event) => event._tag === "pre-build" || event._tag === "post-build"),
      ).toEqual([]);
    });
  });

  test("dispatches a user artifact build again when its build key changes", async () => {
    await withTempUserRoots(async () => {
      // Given the same user app described with different build inputs.
      const firstPlan: AppPlan = {
        ...plan,
        services: { [web.name]: derivedService({ environment: { BUILD_INPUT: "one" } }) },
      };
      const secondPlan: AppPlan = {
        ...plan,
        services: { [web.name]: derivedService({ environment: { BUILD_INPUT: "two" } }) },
      };
      const { provider, calls } = derivedProvider();

      // When the changed plan builds against the same state store.
      const second = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(firstPlan);
            return yield* orchestrator.build(secondPlan);
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then the changed build key is a miss.
      expect(calls.builds).toBe(2);
      expect(second.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:2",
        digest: "sha256:derived-2",
        origin: "build",
      });
    });
  });

  test("redacts proxy credentials carried in artifact build args", async () => {
    await withTempUserRoots(async () => {
      // Given a build arg pair that carries proxy userinfo, not a secret-named value.
      const context = await mkdtemp(join(makeLandoPaths().roots.userDataRoot, "build-args-context-"));
      await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
      const built: ServicePlan = {
        ...web,
        artifact: {
          kind: "build",
          context: AbsolutePath.make(context),
          contentHash: "sha256:context",
          args: { HTTP_PROXY: "http://arguser:argpass-hunter2@127.0.0.1:3128" },
        },
        extensions: {
          "@lando/core/service-features": {
            buildSteps: [{ id: "image", phase: "build", command: ["echo", "build"] }],
          },
        },
      };
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          (spec.onOutput === undefined
            ? Effect.die("onOutput was not supplied")
            : spec.onOutput("argpass-hunter2 http://arguser:argpass-hunter2@127.0.0.1:3128\n")
          ).pipe(Effect.as({ providerId, ref: "built:web" })),
      };

      // When
      const events = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const orchestrator = yield* BuildOrchestrator;
            yield* orchestrator.build({ ...plan, services: { [built.name]: built } });
            return [...(yield* Queue.clear(queue))];
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then
      const start = events.find((event) => event._tag === "task.start");
      if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
      const transcript = await readFile(String(start.transcriptPath), "utf8");
      expect(transcript).toContain("[redacted]");
      expect(transcript).not.toContain("argpass-hunter2");
      expect(transcript).not.toContain("arguser");
    });
  });
  test("redacts a host proxy credential from a provider build failure", async () => {
    await withTempUserRoots(async () => {
      // Given the host proxy carries credentials the provider echoes.
      const password = "host-proxy-hunter2";
      const username = "hostproxyuser";
      const previousProxy = process.env.HTTPS_PROXY;
      process.env.HTTPS_PROXY = `http://${username}:${password}@127.0.0.1:3128`;
      try {
        const failure = new ProviderUnavailableError({
          providerId: "test",
          operation: "buildArtifact",
          message: `proxy rejected ${password} for ${username}`,
          remediation: "Check the proxy configuration and retry.",
        });
        const provider = {
          ...TestRuntimeProvider,
          buildArtifact: () => Effect.fail(failure),
        };

        // When
        const error = await Effect.runPromise(
          Effect.flip(
            Effect.flatMap(BuildOrchestrator, (orchestrator) =>
              orchestrator.build({ ...plan, services: { [web.name]: web } }),
            ),
          ).pipe(Effect.provide(layer(provider))),
        );

        // Then
        expect(error._tag).toBe("ProviderUnavailableError");
        if (error._tag !== "ProviderUnavailableError") throw error;
        expect(error.message).not.toContain(password);
        expect(error.message).not.toContain(username);
        expect(error.message).toBe("proxy rejected [redacted] for [redacted]");
        expect(error.operation).toBe("buildArtifact");
        expect(error.remediation).toBe(failure.remediation);
      } finally {
        if (previousProxy === undefined) Reflect.deleteProperty(process.env, "HTTPS_PROXY");
        else process.env.HTTPS_PROXY = previousProxy;
      }
    });
  });

  test("a newer failed refresh hides an earlier recorded success", async () => {
    await withTempUserRoots(async () => {
      // Given a user app whose derived artifact build succeeded once.
      const derived = derivedService();
      const buildPlan: AppPlan = { ...plan, services: { [web.name]: derived } };
      const failure = new ProviderInternalError({
        providerId: "test",
        operation: "buildArtifact",
        message: "refresh build failed",
        remediation: "Fix the failing build step.",
      });
      let builds = 0;
      const provider = {
        ...derivedProvider().provider,
        buildArtifact: () => {
          builds += 1;
          if (builds === 2) return Effect.fail(failure);
          return Effect.succeed({
            providerId,
            ref: `php-derived:${builds}`,
            digest: `sha256:derived-${builds}`,
          });
        },
      };

      // When the plan succeeds, rebuilds with refresh and fails, then builds plainly again.
      const { refresh, third } = await Effect.runPromise(
        Effect.flatMap(BuildOrchestrator, (orchestrator) =>
          Effect.gen(function* () {
            yield* orchestrator.build(buildPlan);
            const refresh = yield* Effect.result(orchestrator.build(buildPlan, { refresh: true }));
            const third = yield* orchestrator.build(buildPlan);
            return { refresh, third };
          }),
        ).pipe(Effect.provide(layer(provider))),
      );

      // Then the newer failure hides the older success and the provider builds again.
      expect(refresh).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ProviderInternalError",
          operation: "buildArtifact",
          message: "refresh build failed",
        },
      });
      expect(builds).toBe(3);
      expect(third.services[web.name]?.artifact).toEqual({
        kind: "ref",
        ref: "php-derived:3",
        digest: "sha256:derived-3",
        origin: "build",
      });
    });
  });

  test("reusing an older artifact key moves it to the newest position", async () => {
    await withTempUserRoots(async () => {
      // Given a recorded key for this plan that precedes a newer recorded key of the same identity.
      const store = makeTestStateStore();
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          spec.service === web.name
            ? Effect.die("a reused step must not build")
            : Effect.succeed({ providerId, ref: `${spec.service}:test` }),
      };
      const buildKey = await Effect.runPromise(buildKeyForService(provider, web));
      const root = makeLandoPaths().roots.userDataRoot;
      const directory = join(root, "builds", String(plan.id), "artifact", "web");
      const olderPath = join(directory, `${buildKey}.log`);
      const newerPath = join(directory, "newer.log");
      await mkdir(directory, { recursive: true });
      await writeFile(olderPath, "version 6\n");
      await writeFile(newerPath, "version 7\n");
      const injected = Layer.succeed(StateStore, store.service);

      // When the plan reuses the older key.
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const stateStore = yield* StateStore;
          const bucket = yield* openAppBuildResults(stateStore, String(plan.id));
          yield* recordBuildResult(bucket, {
            buildKey,
            service: web.name,
            phase: "artifact",
            outcome: "complete",
            exitCode: 0,
            durationMs: 1,
            artifactRef: "web:test",
            transcriptPath: AbsolutePath.make(olderPath),
          });
          yield* recordBuildResult(bucket, {
            buildKey: "newer-key",
            service: web.name,
            phase: "artifact",
            outcome: "complete",
            exitCode: 0,
            durationMs: 1,
            artifactRef: "web:newer",
            transcriptPath: AbsolutePath.make(newerPath),
          });
          const built = yield* (yield* BuildOrchestrator).build(plan);
          const entries = (yield* bucket.get) ?? [];
          return { artifact: built.services[web.name]?.artifact, entries };
        }).pipe(Effect.provide(layer(provider, injected))),
      );

      // Then the reused key is last, so the next rotation and `logs --build` see it as current.
      expect(result.artifact).toMatchObject({ ref: "web:test" });
      expect(
        result.entries.filter((entry) => entry.service === web.name).map((entry) => entry.buildKey),
      ).toEqual(["newer-key", buildKey]);
    });
  });

  test("a warm artifact start writes no build-results bytes", async () => {
    await withTempUserRoots(async () => {
      // Given a plan whose artifact results are already recorded.
      const store = makeTestStateStore();
      const injected = Layer.succeed(StateStore, store.service);
      const provider = {
        ...TestRuntimeProvider,
        buildArtifact: (spec: ArtifactBuildSpec) =>
          Effect.succeed({ providerId, ref: `${spec.service}:test` }),
      };

      // When a second, fully reused build runs.
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const stateStore = yield* StateStore;
          const bucket = yield* openAppBuildResults(stateStore, String(plan.id));
          const orchestrator = yield* BuildOrchestrator;
          yield* orchestrator.build(plan);
          const before = yield* store.readRaw(bucket.path);
          yield* orchestrator.build(plan);
          const after = yield* store.readRaw(bucket.path);
          return { before, after };
        }).pipe(Effect.provide(layer(provider, injected))),
      );

      // Then the index was read but not rewritten.
      expect(result.before).not.toBeNull();
      expect(result.after).toEqual(result.before);
    });
  });
});
