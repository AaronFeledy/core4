import { describe, expect, test } from "bun:test";

import { DateTime, Effect, Fiber, Layer, Stream } from "effect";

import { ProviderInternalError } from "@lando/core/errors";
import {
  type ArtifactBuildSpec,
  BuildOrchestrator,
  EventService,
  RuntimeProviderRegistry,
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
import { RedactionService } from "../../src/redaction/service.ts";
import { BuildOrchestratorLive } from "../../src/services/build-orchestrator.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";

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
  metadata,
  extensions: {},
};

const registryLayer = (provider = TestRuntimeProvider) =>
  Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });

const layer = (provider = TestRuntimeProvider) =>
  BuildOrchestratorLive.pipe(
    Layer.provideMerge(EventServiceLive),
    Layer.provideMerge(registryLayer(provider)),
  );

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
});

describe("BuildOrchestratorLive", () => {
  test("builds every service sequentially and publishes build events in order", async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const provider = {
      ...TestRuntimeProvider,
      buildArtifact: (spec: ArtifactBuildSpec) =>
        Effect.gen(function* () {
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
          yield* Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(plan));
          return yield* Fiber.join(subscriber);
        }),
      ).pipe(Effect.provide(layer(provider))),
    );

    expect(calls).toEqual(["web", "db"]);
    expect(maxActive).toBe(1);
    expect(Array.from(events).map((event) => [event._tag, event.serviceName])).toEqual([
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
      ).pipe(
        Effect.provide(
          BuildOrchestratorLive.pipe(
            Layer.provideMerge(EventServiceLive),
            Layer.provideMerge(registryLayer(provider)),
            Layer.provideMerge(redactionLayer),
          ),
        ),
      ),
    );

    expect(Array.from(events)).toHaveLength(2);
    for (const event of events) {
      expect(event.appRef.id).not.toContain("topsecret");
      expect(event.appRef.id).toContain("[redacted]");
      expect(event.appRef.root).not.toContain("topsecret");
      expect(event.appRef.root).toContain("[redacted]");
      expect(String(event.serviceName)).not.toContain("topsecret");
      expect(String(event.serviceName)).toContain("[redacted]");
      expect(String(event.providerId)).not.toContain("topsecret");
      expect(String(event.providerId)).toContain("[redacted]");
      expect(DateTime.isDateTime(event.timestamp)).toBe(true);
    }
  });
});
