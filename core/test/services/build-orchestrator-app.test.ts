import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect, Fiber, Layer, Queue, Stream } from "effect";

import { ProviderInternalError } from "@lando/core/errors";
import {
  type ArtifactBuildSpec,
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/core/services";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeLandoPaths } from "../../src/config/paths.ts";
import { RedactionService } from "../../src/redaction/service.ts";
import { BuildOrchestratorLive } from "../../src/services/build-orchestrator.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { StateStoreLive } from "../../src/state/service.ts";

const providerId = ProviderId.make("test");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-17T00:00:00Z"),
  source: "build-orchestrator-app.test",
  runtime: 4 as const,
};

const service = (name: string, milliseconds: number) => ({
  name: ServiceName.make(name),
  type: "test",
  provider: providerId,
  primary: name === "appserver",
  artifact: { kind: "ref" as const, ref: `test/${name}:latest` },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {
    "@lando/core/service-features": {
      buildSteps: [
        { id: "dependencies", phase: "app", command: { command: ["sleep", String(milliseconds)] } },
      ],
    },
  },
});

const services = [service("appserver", 500), service("node", 500), service("python", 350)];
const plan: AppPlan = {
  id: AppId.make("three-service-build"),
  name: "Three service build",
  slug: "three-service-build",
  root: AbsolutePath.make("/tmp/three-service-build"),
  provider: providerId,
  services: Object.fromEntries(services.map((entry) => [entry.name, entry])),
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const withTempRoots = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-app-build-")));
  const previousCache = process.env.LANDO_USER_CACHE_ROOT;
  const previousData = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
  process.env.LANDO_USER_DATA_ROOT = join(root, "data");
  try {
    await mkdir(process.env.LANDO_USER_CACHE_ROOT, { recursive: true });
    await mkdir(process.env.LANDO_USER_DATA_ROOT, { recursive: true });
    return await run(root);
  } finally {
    if (previousCache === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
    else process.env.LANDO_USER_CACHE_ROOT = previousCache;
    if (previousData === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousData;
    await rm(root, { recursive: true, force: true });
  }
};

const makeLayer = (provider: RuntimeProviderShape) => {
  const paths = Layer.succeed(PathsService, makeLandoPaths());
  const registry = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  const redaction = Layer.succeed(RedactionService, {
    forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
  });
  const dependencies = Layer.mergeAll(EventServiceLive, paths, registry, StateStoreLive, redaction);
  return Layer.mergeAll(dependencies, BuildOrchestratorLive.pipe(Layer.provide(dependencies)));
};

const outputStream = (name: string, delay: number, exitCode: number) =>
  Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(`${name} topsecret\n`) }).pipe(
    Stream.concat(Stream.fromEffect(Effect.sleep(`${delay} millis`).pipe(Effect.as({ exitCode })))),
  );

describe("BuildOrchestrator app phase", () => {
  test("runs three services concurrently, streams redacted detail, writes raw transcripts, and caches", async () => {
    await withTempRoots(async () => {
      // Given
      let active = 0;
      let maxActive = 0;
      let calls = 0;
      let detailDuringWork = false;
      const provider = {
        ...TestRuntimeProvider,
        execStream: (
          target: { readonly service: ServiceName },
          command: { readonly command: ReadonlyArray<string> },
        ) =>
          Stream.acquireRelease(
            Effect.sync(() => {
              calls += 1;
              active += 1;
              maxActive = Math.max(maxActive, active);
              return String(target.service);
            }),
            () =>
              Effect.sync(() => {
                active -= 1;
              }),
          ).pipe(Stream.flatMap((name) => outputStream(name, Number(command.command[1] ?? "0"), 0))),
      } satisfies RuntimeProviderShape;

      // When
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const orchestrator = yield* BuildOrchestrator;
            const detailSubscriber = yield* eventService.subscribe("task.detail").pipe(
              Stream.take(3),
              Stream.runForEach(() =>
                Effect.sync(() => {
                  detailDuringWork ||= active > 0;
                }),
              ),
              Effect.fork,
            );
            yield* Effect.sleep("1 millis");
            const started = performance.now();
            yield* orchestrator.buildApp(plan);
            const elapsedMs = performance.now() - started;
            yield* Fiber.join(detailSubscriber);
            yield* orchestrator.buildApp(plan);
            return { elapsedMs, events: [...(yield* Queue.takeAll(queue))] };
          }),
        ).pipe(Effect.provide(makeLayer(provider))),
      );

      // Then
      expect(result.elapsedMs).toBeLessThan(600);
      expect(maxActive).toBe(3);
      expect(detailDuringWork).toBe(true);
      expect(calls).toBe(3);
      const details = result.events.filter((event) => event._tag === "task.detail");
      expect(details).toHaveLength(3);
      expect(JSON.stringify(details)).not.toContain("topsecret");
      const starts = result.events.filter((event) => event._tag === "task.start");
      expect(starts).toHaveLength(6);
      for (const start of starts) {
        expect(start.transcriptPath).toContain(`/builds/${String(plan.id)}/app/`);
        expect(await readFile(String(start.transcriptPath), "utf8")).toContain("topsecret");
      }
      expect(result.events.filter((event) => event._tag === "task.complete")).toHaveLength(6);
      const skips = result.events.filter((event) => event._tag === "build-step-skip");
      expect(skips).toHaveLength(3);
      const secondTreeStart = result.events.findIndex(
        (event, index) =>
          event._tag === "task.tree.start" &&
          result.events.slice(0, index).some((candidate) => candidate._tag === "task.tree.start"),
      );
      expect(secondTreeStart).toBeGreaterThan(-1);
      for (const skip of skips) {
        const taskId = `${String(skip.serviceName)}:app:dependencies`;
        const startIndex = result.events.findIndex(
          (event, index) => index > secondTreeStart && event._tag === "task.start" && event.taskId === taskId,
        );
        const skipIndex = result.events.indexOf(skip);
        const completeIndex = result.events.findIndex(
          (event, index) => index > skipIndex && event._tag === "task.complete" && event.taskId === taskId,
        );
        expect(startIndex).toBeLessThan(skipIndex);
        expect(skipIndex).toBeLessThan(completeIndex);
      }
    });
  });

  test("aggregates an app failure after healthy siblings complete", async () => {
    // Given
    const completed: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      execStream: (target: { readonly service: ServiceName }) =>
        outputStream(
          String(target.service),
          target.service === ServiceName.make("node") ? 10 : 40,
          target.service === ServiceName.make("node") ? 7 : 0,
        ).pipe(
          Stream.tap((chunk) =>
            "exitCode" in chunk && chunk.exitCode === 0
              ? Effect.sync(() => void completed.push(String(target.service)))
              : Effect.void,
          ),
        ),
    } satisfies RuntimeProviderShape;

    // When
    const error = await withTempRoots(() =>
      Effect.runPromise(
        Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
          Effect.provide(makeLayer(provider)),
        ),
      ),
    );

    // Then
    expect(completed.sort()).toEqual(["appserver", "python"]);
    expect(error).toMatchObject({ _tag: "BuildPhaseFailedError", phase: "app" });
    if (error._tag !== "BuildPhaseFailedError") throw error;
    expect(error.failures).toHaveLength(1);
    expect(error.failures[0]).toMatchObject({
      step: { service: ServiceName.make("node") },
      exitCode: 7,
    });
  });
});

describe("BuildOrchestrator artifact phase", () => {
  test("interrupts in-flight siblings on the first artifact failure", async () => {
    // Given
    const artifactPlan: AppPlan = {
      ...plan,
      services: Object.fromEntries(
        services.map((entry) => [
          entry.name,
          {
            ...entry,
            extensions: {
              "@lando/core/service-features": {
                buildSteps: [{ id: "image", phase: "build", command: { command: ["prepare-image"] } }],
              },
            },
          },
        ]),
      ),
    };
    const calls: string[] = [];
    let siblingInterrupted = false;
    const failure = new ProviderInternalError({
      providerId,
      operation: "buildArtifact",
      message: "synthetic artifact failure",
    });
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: (spec: ArtifactBuildSpec) => {
        calls.push(String(spec.service));
        if (spec.service === ServiceName.make("appserver")) {
          return Effect.sleep("20 millis").pipe(Effect.zipRight(Effect.fail(failure)));
        }
        return Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              siblingInterrupted = true;
            }),
          ),
        );
      },
    } satisfies RuntimeProviderShape;

    // When
    const result = await withTempRoots(() =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const orchestrator = yield* BuildOrchestrator;
            const error = yield* Effect.flip(orchestrator.build(artifactPlan));
            return { error, events: [...(yield* Queue.takeAll(queue))] };
          }),
        ).pipe(Effect.provide(makeLayer(provider))),
      ),
    );

    // Then
    expect(result.error).toBe(failure);
    expect(calls).toEqual(["appserver", "node"]);
    expect(siblingInterrupted).toBe(true);
    expect(
      result.events
        .filter((event) => event._tag === "build-step-skip")
        .map((event) => [event.serviceName, event.reason, event.cached]),
    ).toEqual([
      [ServiceName.make("node"), "phase-aborted", false],
      [ServiceName.make("python"), "phase-aborted", false],
    ]);
    expect(
      result.events
        .filter((event) => event._tag === "task.fail")
        .map((event) => event.taskId)
        .sort(),
    ).toEqual(["appserver", "node", "python"]);
    expect(result.events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
      succeeded: 0,
      failed: 3,
    });
  });
});
