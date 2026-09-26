import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Queue, Stream } from "effect";

import { ScratchResourceScannerLive } from "@lando/engine/scratch-app/scanner";
import { ConfigServiceLive } from "@lando/engine/services/config";
import { ProviderUnavailableError, ScratchAppError, ScratchAppNotFoundError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { EventService, RuntimeProviderRegistry, ScratchAppService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { poweroff } from "../../src/cli/commands/poweroff";

test.each(["orphan", "prune-failure", "registered", "destroy-failure"] as const)(
  "poweroff handles %s scratch resources without hiding failures",
  async (mode) => {
    // Given: a labeled scratch container and independently controlled registry state.
    const root = await mkdtemp(join(tmpdir(), "poweroff-orphan-"));
    const id = AppId.make("scratch-orphan-abc123");
    const calls: string[] = [];
    const providerFailure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "removeObservedService",
      message: "Cannot remove scratch container",
      remediation: "Restore provider access.",
    });
    const providerLayer = Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () =>
        Effect.succeed({
          ...TestRuntimeProvider,
          list: () =>
            Effect.succeed([
              {
                app: id,
                service: ServiceName.make("web"),
                providerId: ProviderId.make("lando"),
                status: "running" as const,
                labels: { "dev.lando.scratch": "TRUE", "dev.lando.scratch-id": id },
              },
            ]),
          listVolumes: () => Effect.succeed([]),
          removeObservedService: () =>
            Effect.gen(function* () {
              calls.push("prune");
              if (mode === "prune-failure") return yield* Effect.fail(providerFailure);
              return { kind: "removed" as const };
            }),
        }),
    });
    const scratchLayer = Layer.succeed(ScratchAppService, {
      kind: "scratch",
      root: Effect.succeed(AbsolutePath.make(root)),
      ensureRoot: Effect.die("unexpected ensureRoot"),
      synthesizeId: () => Effect.die("unexpected synthesizeId"),
      paths: () => Effect.die("unexpected paths"),
      acquire: () => Effect.die("unexpected acquire"),
      resolveById: () => Effect.die("unexpected resolve"),
      list: () => Effect.succeed([]),
      info: () => Effect.die("unexpected info"),
      start: () => Effect.die("unexpected start"),
      stop: () => Effect.die("unexpected stop"),
      gc: () => Effect.die("must prune only this orphan, not every scratch app"),
      destroy: (target, options) =>
        Effect.gen(function* () {
          calls.push("destroy");
          expect(target).toBe(id);
          expect(options).toEqual({ keepVolumes: false });
          switch (mode) {
            case "registered":
              return { id, app: { kind: "scratch" as const, id, root: AbsolutePath.make(root) } };
            case "destroy-failure":
              return yield* Effect.fail(new ScratchAppError({ operation: "destroy", message: "Denied" }));
            case "orphan":
            case "prune-failure":
              return yield* Effect.fail(
                new ScratchAppNotFoundError({
                  id,
                  message: "Missing registry entry",
                  suggestions: [],
                  remediation: "List registered scratch apps.",
                }),
              );
          }
        }),
    });
    const events = Layer.succeed(EventService, {
      publish: () => Effect.void,
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<LandoEvent>(),
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    });
    try {
      // When: poweroff uses the real GC scanner against the discovered scratch app.
      const result = await Effect.runPromise(
        poweroff({
          userDataRoot: root,
          userCacheRoot: root,
          discoverContainers: async () => [
            { appId: id, appName: id, appRoot: root, providerId: "lando", services: ["web"], scratch: true },
          ],
          stopRuntimeService: async () => {
            calls.push("runtime");
            return { terminated: true };
          },
        }).pipe(
          Effect.either,
          Effect.provide(
            Layer.mergeAll(
              ConfigServiceLive,
              providerLayer,
              scratchLayer,
              events,
              ScratchResourceScannerLive.pipe(Layer.provide(providerLayer)),
            ),
          ),
        ),
      );
      // Then: only a missing registry entry permits pruning, and failure keeps the runtime available.
      switch (mode) {
        case "orphan":
        case "registered":
          expect(result._tag).toBe("Right");
          if (result._tag === "Right") expect(result.right.appsPoweredOff).toEqual([id]);
          expect(calls).toEqual(mode === "orphan" ? ["destroy", "prune", "runtime"] : ["destroy", "runtime"]);
          break;
        case "prune-failure":
        case "destroy-failure":
          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left).toMatchObject({ _tag: "PoweroffStopError", appId: id, providerId: "lando" });
            if (result.left._tag === "PoweroffStopError") {
              expect(result.left.remediation).toContain("lando scratch gc --prune");
              if (mode === "prune-failure")
                expect(result.left.cause).toMatchObject({ cause: providerFailure });
            }
          }
          expect(calls).toEqual(mode === "prune-failure" ? ["destroy", "prune"] : ["destroy"]);
          break;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
