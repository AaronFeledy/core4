import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Queue, Stream } from "effect";

import { ConfigServiceLive } from "@lando/engine/services/config";
import { ProviderUnavailableError, ScratchAppError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { EventService, RuntimeProviderRegistry, ScratchAppService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { poweroffSpec } from "../../src/cli/command-specs/apps/poweroff";
import { type PoweroffOptions, poweroff } from "../../src/cli/commands/poweroff";

const withPoweroff = async (
  run: (fixture: Awaited<ReturnType<typeof makeFixture>>) => Promise<void>,
  failure?: "provider" | "no-plan" | "scratch",
) => {
  const fixture = await makeFixture(failure);
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
};

const makeFixture = async (failure?: "provider" | "no-plan" | "scratch") => {
  const root = await mkdtemp(join(tmpdir(), "poweroff-production-"));
  const calls: string[] = [];
  const events: string[] = [];
  const unavailable = new ProviderUnavailableError({
    message: "Test provider unavailable",
    providerId: "docker",
    operation: "destroy",
    remediation: "Start the test provider.",
  });
  const providerLayer = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([ProviderId.make("lando"), ProviderId.make("docker")]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    select: (plan) =>
      Effect.succeed({
        ...TestRuntimeProvider,
        id: plan?.provider ?? ProviderId.make("docker"),
        destroy: (target, options) =>
          Effect.gen(function* () {
            calls.push(`${plan?.provider}:${target.app}`);
            if (failure === "provider") return yield* Effect.fail(unavailable);
            if (failure === "no-plan") return { kind: "no-op" as const, reason: "no-applied-plan" as const };
            expect(options).toEqual({ volumes: false, removeState: false });
            expect(target.plan).toBeUndefined();
            return { kind: "destroyed" as const };
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
    destroy: (id, options) =>
      Effect.gen(function* () {
        expect(options?.keepVolumes).not.toBe(true);
        calls.push(`scratch:${id}`);
        if (failure === "scratch")
          return yield* Effect.fail(
            new ScratchAppError({
              message: "Scratch cleanup failed",
              operation: "destroy",
              remediation: "Retry scratch cleanup.",
            }),
          );
        return {
          id: AppId.make(id),
          app: { kind: "scratch" as const, id: AppId.make(id), root: AbsolutePath.make(root) },
        };
      }),
    gc: () => Effect.die("unexpected gc"),
  });
  const options: PoweroffOptions = {
    userDataRoot: root,
    userCacheRoot: root,
    discoverContainers: async () => [
      { appId: "global", appName: "global", providerId: "docker", appRoot: root, services: ["proxy"] },
      { appId: "user", appName: "user", providerId: "docker", appRoot: root, services: ["web"] },
      {
        appId: "scratch-one",
        appName: "scratch-one",
        providerId: "lando",
        appRoot: root,
        services: ["web"],
        scratch: true,
      },
    ],
    stopRuntimeService: async () => {
      calls.push("runtime");
      return { terminated: true };
    },
  };
  const eventLayer = Layer.succeed(EventService, {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event._tag);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<LandoEvent>(),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  });
  const layer = Layer.mergeAll(ConfigServiceLive, providerLayer, scratchLayer, eventLayer);
  return { root, calls, options, layer, events };
};

test("stops owning providers before host teardown when no stop seam is injected", async () => {
  // Given: discovered apps on different providers, including a marked scratch.
  await withPoweroff(async ({ calls, options, layer }) => {
    // When: the same default operation used by command execution runs.
    const result = await Effect.runPromise(poweroff(options).pipe(Effect.provide(layer)));
    // Then: actual provider stops, scratch cleanup, and host teardown are ordered.
    expect(calls).toEqual(["docker:user", "scratch:scratch-one", "lando:global", "runtime"]);
    expect(result.appsPoweredOff).toEqual(["user", "scratch-one", "global"]);
  });
});

test.each([
  [true, false, ["docker:user", "scratch:scratch-one", "runtime"], 0],
  [false, true, ["docker:user", "lando:global", "runtime"], 1],
  [true, true, ["docker:user", "runtime"], 1],
] as const)(
  "honors keep-global=%s and keep-scratch=%s in the production default",
  async (keepGlobal, keepScratch, expected, keptScratch) => {
    // Given: the same multi-provider inventory with keep flags.
    await withPoweroff(async ({ calls, options, layer }) => {
      // When: poweroff runs without an injected stop.
      const result = await Effect.runPromise(
        poweroff({ ...options, keepGlobal, keepScratch }).pipe(Effect.provide(layer)),
      );
      // Then: kept apps never reach their lifecycle primitive.
      expect(calls).toEqual([...expected]);
      expect(result.keptGlobalApp).toBe(keepGlobal);
      expect(result.keptScratchApps).toBe(keptScratch);
    });
  },
);

test.each(["provider", "no-plan", "scratch"] as const)(
  "fails before host teardown when stopping returns %s",
  async (failure) => {
    // Given: an app that cannot be stopped by its owning provider.
    await withPoweroff(async ({ calls, options, layer }) => {
      // When: poweroff uses its production stop.
      const result = await Effect.runPromise(poweroff(options).pipe(Effect.either, Effect.provide(layer)));
      // Then: no successful result or runtime teardown hides the failed stop.
      expect(result._tag).toBe("Left");
      if (result._tag !== "Left") throw new Error("Expected a typed stop failure");
      expect(result.left).toMatchObject({
        _tag: "PoweroffStopError",
        appId: failure === "scratch" ? "scratch-one" : "user",
        providerId: failure === "scratch" ? "lando" : "docker",
      });
      expect(calls).toEqual(failure === "scratch" ? ["docker:user", "scratch:scratch-one"] : ["docker:user"]);
    }, failure);
  },
);

test("turns injected stop rejection into a tagged failure", async () => {
  // Given: a rejecting stop seam.
  await withPoweroff(async ({ calls, options, layer }) => {
    // When: the injected stop rejects.
    const result = await Effect.runPromise(
      poweroff({
        ...options,
        stopApp: async () => {
          throw new Error("stop failed");
        },
      }).pipe(Effect.either, Effect.provide(layer)),
    );
    // Then: poweroff fails without claiming success or shutting down the runtime.
    expect(result._tag).toBe("Left");
    expect(calls).toEqual([]);
  });
});

test("provides provider and scratch services through command metadata", () => {
  // Given: the shared spec used by native and retained command execution.
  // When: its runtime requirement is inspected.
  const bootstrap = poweroffSpec.bootstrap;
  // Then: the default stop can resolve its services outside an app root.
  expect(bootstrap).toBe("scratch");
});

test.each([false, true])("stops a scratch-prefixed user app when keep-scratch=%s", async (keepScratch) => {
  // Given: a user app whose name is not a scratch identity marker.
  await withPoweroff(async ({ calls, options, layer, root }) => {
    // When: the production default handles that app with either keep policy.
    const result = await Effect.runPromise(
      poweroff({
        ...options,
        keepScratch,
        discoverContainers: async () => [
          {
            appId: "scratch-project",
            appName: "scratch-project",
            providerId: "docker",
            appRoot: root,
            services: ["web"],
          },
        ],
      }).pipe(Effect.provide(layer)),
    );
    // Then: its owning provider stops it without destructive scratch cleanup.
    expect(calls).toEqual(["docker:scratch-project", "runtime"]);
    expect(result.appsPoweredOff).toEqual(["scratch-project"]);
    expect(result.keptScratchApps).toBe(0);
  });
});

test.each([false, true])("emits the global stop pair unless keep-global=%s", async (keepGlobal) => {
  // Given: the production inventory and an event subscriber.
  await withPoweroff(async ({ options, layer, events }) => {
    // When: poweroff applies the global keep policy.
    await Effect.runPromise(poweroff({ ...options, keepGlobal }).pipe(Effect.provide(layer)));
    // Then: only an actual global stop publishes its lifecycle pair.
    expect(events).toEqual(keepGlobal ? [] : ["pre-global-stop", "post-global-stop"]);
  });
});

test("omits the global post event when its provider fails", async () => {
  // Given: a global app whose provider cannot stop it.
  await withPoweroff(async ({ options, layer, events, root }) => {
    // When: the production default attempts only the global stop.
    const result = await Effect.runPromise(
      poweroff({
        ...options,
        discoverContainers: async () => [
          { appId: "global", appName: "global", providerId: "lando", appRoot: root, services: [] },
        ],
      }).pipe(Effect.either, Effect.provide(layer)),
    );
    // Then: the failed stop never emits a success event.
    expect(result._tag).toBe("Left");
    expect(events).toEqual(["pre-global-stop"]);
  }, "provider");
});
