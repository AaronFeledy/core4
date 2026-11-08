import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  FileSyncSessionRef,
  PortablePath,
  ServiceName,
  type ServiceShutdownObservation,
} from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { FileSyncResolver } from "../../src/plugins/file-sync-resolver.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { fixture, stale, target } from "./legacy-teardown-support.ts";
import { web } from "./start-progress-topology-support.ts";

test.each(["stop", "destroy", "renamed-destroy"] as const)(
  "%s includes retired services and preserves quiescence observations over later absence",
  async (command) => {
    const harness = fixture();
    const worker = { ...web, name: ServiceName.make("worker") };
    const app = { ...target.app, id: stale.id };
    const spec = {
      app,
      service: worker.name,
      mountKey: "code",
      source: stale.root,
      target: { _tag: "volume" as const, name: "retired-code", path: PortablePath.make("/app") },
      mode: "two-way-safe" as const,
      excludes: [],
    };
    const session = {
      app,
      service: worker.name,
      mountKey: spec.mountKey,
      spec,
      ref: FileSyncSessionRef.make("retired-sync"),
      status: "running" as const,
      lastUpdatedAt: DateTime.makeUnsafe("2026-09-23T00:00:00Z"),
    };
    harness.applied[0] = { ...stale, services: { [worker.name]: worker } };
    const observed: ServiceShutdownObservation = {
      appId: stale.id,
      providerId: stale.provider,
      service: worker.name,
      containerId: "retired-worker",
      status: "exited",
      exitCode: 137,
      oomKilled: true,
    };
    try {
      if (command === "renamed-destroy")
        await Bun.write(join(target.root, ".lando.yml"), "name: third-name\n");
      const base = await Effect.runPromise(harness.runtimeProviderRegistry.select());
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          if (command === "stop") return yield* stopApp({}, target);
          if (command === "renamed-destroy")
            return yield* withResolvedCwd(target.root, destroyApp({ volumes: true, yes: true }));
          return yield* destroyApp({ volumes: true }, target);
        }).pipe(
          Effect.provideService(LandofileService, {
            discover: Effect.succeed(literalTestLandofile({ name: "third-name" }, target.root)),
          }),
          Effect.provideService(AppPlanner, {
            plan: () =>
              Effect.fail(
                new LandofileValidationError({
                  file: join(target.root, ".lando.yml"),
                  message: "Planning fails",
                  remediation: "Fix service composition",
                  issues: [],
                }),
              ),
          }),
          Effect.provideService(RuntimeProviderRegistry, {
            ...harness.runtimeProviderRegistry,
            select: () =>
              Effect.succeed({
                ...base,
                inspectAppliedFileSync: (plan) =>
                  Effect.succeed(
                    plan.id === stale.id
                      ? { status: "accelerated" as const, engineId: TestFileSyncEngine.id, sessions: [spec] }
                      : { status: "ordinary" as const },
                  ),
                quiesceForFileSync: () => Effect.succeed({ shutdownObservations: [observed] }),
                destroy: (ref, options) =>
                  base.destroy(ref, options).pipe(
                    Effect.map((outcome) => ({
                      ...outcome,
                      ...(ref.app === stale.id
                        ? {
                            shutdownObservations: [
                              {
                                appId: stale.id,
                                providerId: stale.provider,
                                service: worker.name,
                                status: "unknown" as const,
                                reason: "container-absent" as const,
                              },
                            ],
                          }
                        : {}),
                    })),
                  ),
              }),
          }),
          Effect.provideService(FileSyncResolver, {
            candidates: [],
            select: () => Effect.succeed(undefined),
            acquire: () =>
              Effect.succeed({
                ...TestFileSyncEngine,
                isAvailable: Effect.succeed(true),
                listSessions: () => Effect.succeed([session]),
              }),
          }),
          Effect.provide(harness.layer),
        ),
      );
      expect("servicesStopped" in result ? result.servicesStopped : result.servicesDestroyed).toEqual([
        "worker",
        "web",
      ]);
      expect(result.shutdownObservations).toEqual([observed]);
      if ("volumesRemoved" in result) expect(result.volumesRemoved).toBe(true);
    } finally {
      if (command === "renamed-destroy") rmSync(join(target.root, ".lando.yml"));
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
