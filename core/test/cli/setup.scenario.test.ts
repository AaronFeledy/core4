import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";

import { makeRuntimeProvider } from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";
import { ConfigService, EventService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { setupSpec } from "../../src/cli/oclif/commands/meta/setup.ts";
import { makeHttpClientLive } from "../../src/http-client/live.ts";

interface EventSink {
  readonly events: LandoEvent[];
  readonly publish: (event: LandoEvent) => Effect.Effect<void>;
}

const collector = (): EventSink => {
  const events: LandoEvent[] = [];
  return {
    events,
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  };
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const makeEventServiceLayer = (sink: EventSink) =>
  Layer.succeed(EventService, {
    publish: sink.publish,
    subscribe: () => Stream.die("not used in setup scenario test"),
    subscribeQueue: Effect.die("not used in setup scenario test"),
    waitFor: () => Effect.die("not used in setup scenario test"),
    waitForAny: () => Effect.die("not used in setup scenario test"),
    query: () => Effect.succeed([]),
  });

const makeSetupLayer = async (sink: EventSink, stateDir: string) => {
  const bundleBytes = new TextEncoder().encode("fake lando runtime bundle");
  const provider = await Effect.runPromise(
    makeRuntimeProvider({
      podmanApi: { info: Effect.succeed({ version: { Version: "6.0.2" } }) },
      podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
      runtimeBundleDownloader: {
        download: Effect.succeed({
          version: "0.0.0-test",
          bytes: bundleBytes,
          sha256: sha256(bundleBytes),
        }),
      },
      platform: "linux",
      stateDir,
      eventService: { publish: sink.publish },
    }),
  );
  const registry = {
    list: Effect.succeed([ProviderId.make("lando")]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  };
  const okProbeFetch = ((_input: string | URL | Request, init?: unknown) => {
    void init;
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;

  return Layer.mergeAll(
    Layer.succeed(RuntimeProviderRegistry, registry),
    makeEventServiceLayer(sink),
    makeConfigServiceLayer(),
    makeHttpClientLive(okProbeFetch),
  );
};

const makeConfigServiceLayer = () => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
  };
  const load = Effect.succeed(config);
  return Layer.succeed(ConfigService, {
    load,
    get: (key) => Effect.map(load, (c) => c[key]),
  });
};

describe("meta:setup task tree progress", () => {
  const originalNetworkEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
    LANDO_NETWORK_CA_CERTS: process.env.LANDO_NETWORK_CA_CERTS,
  };

  beforeEach(() => {
    for (const key of Object.keys(originalNetworkEnv)) Reflect.deleteProperty(process.env, key);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalNetworkEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  test("publishes tree.start, per-step task.start/complete, and tree.complete on the happy path", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-setup-scenario-"));
    try {
      const sink = collector();
      const layer = await makeSetupLayer(sink, stateDir);

      const result = await Effect.runPromise(
        setupSpec.run({ installDir: "/opt/lando" }).pipe(Effect.provide(layer)),
      );

      expect(setupSpec.render?.(result)).toContain("setup complete: Lando runtime (lando)");

      const tags = sink.events.map((event) => event._tag);
      expect(tags[0]).toBe("task.tree.start");
      expect(tags[tags.length - 1]).toBe("task.tree.complete");

      const treeStart = sink.events[0];
      if (treeStart?._tag !== "task.tree.start") {
        throw new Error("expected task.tree.start as first event");
      }
      expect(treeStart.children).toEqual(["bundle", "podman", "socket", "state"]);

      const childTaskStarts = sink.events.filter((event) => event._tag === "task.start");
      const childTaskIds = childTaskStarts.map((event) =>
        event._tag === "task.start" ? event.taskId : undefined,
      );
      expect(childTaskIds).toEqual(["bundle", "podman", "socket", "state"]);

      const childTaskCompletes = sink.events.filter((event) => event._tag === "task.complete");
      expect(childTaskCompletes.length).toBe(4);
      expect(sink.events.some((event) => event._tag === "task.fail")).toBe(false);

      const treeComplete = sink.events[sink.events.length - 1];
      if (treeComplete?._tag !== "task.tree.complete") {
        throw new Error("expected task.tree.complete as last event");
      }
      expect(treeComplete.failed).toBe(0);
      expect(treeComplete.succeeded).toBe(4);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("publishes task.fail and task.tree.complete with failed counts when the Podman socket is unreachable", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-setup-scenario-fail-"));
    try {
      const sink = collector();
      const bundleBytes = new TextEncoder().encode("fake lando runtime bundle");
      let infoCalls = 0;
      const podmanApi = {
        info: Effect.suspend(() => {
          infoCalls += 1;
          if (infoCalls === 1) {
            return Effect.succeed({ version: { Version: "6.0.2" } });
          }
          return Effect.fail(
            new ProviderUnavailableError({
              providerId: "lando",
              operation: "setup",
              message: "Podman API unreachable in test fake.",
            }),
          );
        }),
      };
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          podmanApi,
          podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
          runtimeBundleDownloader: {
            download: Effect.succeed({
              version: "0.0.0-test",
              bytes: bundleBytes,
              sha256: sha256(bundleBytes),
            }),
          },
          platform: "linux",
          stateDir,
          eventService: { publish: sink.publish },
        }),
      );
      const registry = {
        list: Effect.succeed([ProviderId.make("lando")]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      };
      const layer = Layer.mergeAll(
        Layer.succeed(RuntimeProviderRegistry, registry),
        makeEventServiceLayer(sink),
        makeConfigServiceLayer(),
      );

      const exit = await Effect.runPromiseExit(
        setupSpec.run({ installDir: "/opt/lando" }).pipe(Effect.provide(layer)),
      );
      expect(exit._tag).toBe("Failure");

      const tags = sink.events.map((event) => event._tag);
      expect(tags[0]).toBe("task.tree.start");
      expect(tags).toContain("task.fail");
      expect(tags[tags.length - 1]).toBe("task.tree.complete");

      const socketFail = sink.events.find((event) => event._tag === "task.fail" && event.taskId === "socket");
      expect(socketFail).toBeDefined();

      const treeComplete = sink.events[sink.events.length - 1];
      if (treeComplete?._tag !== "task.tree.complete") {
        throw new Error("expected task.tree.complete as last event");
      }
      expect(treeComplete.failed).toBe(1);
      expect(treeComplete.succeeded).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
