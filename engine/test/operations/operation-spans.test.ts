import { expect, test } from "bun:test";
import { DateTime, Effect, Layer, Option, References, Tracer } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { infoForPlan } from "../../src/operations/info.ts";

test("nests provider inspection under the operation span when info runs against the test provider", async () => {
  const providerId = ProviderId.make(TestRuntimeProvider.id);
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-08-22T00:00:00Z"),
    source: "operation-spans",
    runtime: 4 as const,
  };
  const plan: AppPlan = {
    id: AppId.make("operation-spans"),
    name: "operation-spans",
    slug: "operation-spans",
    root: AbsolutePath.make("/tmp/operation-spans"),
    provider: providerId,
    services: {
      [ServiceName.make("web")]: {
        name: ServiceName.make("web"),
        type: "nginx",
        provider: providerId,
        primary: true,
        artifact: { kind: "ref", ref: "nginx:alpine" },
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    inspect: Effect.fn("RuntimeProvider.inspect")(function* (
      target: Parameters<RuntimeProviderShape["inspect"]>[0],
    ) {
      return yield* TestRuntimeProvider.inspect(target);
    }),
  };
  const registry = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );

  const result = await Effect.runPromise(
    infoForPlan(plan).pipe(
      Effect.provide(registry),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(References.TracerEnabled, true),
    ),
  );

  expect(result.services.map((service) => service.service)).toEqual(["web"]);
  expect(
    spans.map((span) => ({
      name: span.name,
      parent: Option.map(span.parent, (parent) => (parent._tag === "Span" ? parent.name : "external")),
    })),
  ).toEqual([
    { name: "AppOperation.infoForPlan", parent: Option.none() },
    { name: "RuntimeProvider.inspect", parent: Option.some("AppOperation.infoForPlan") },
  ]);
  const operation = spans[0];
  const inspection = spans[1];
  expect(operation).toBeDefined();
  expect(inspection).toBeDefined();
  if (operation === undefined || inspection === undefined)
    throw new Error("Expected operation and inspection spans");
  expect(Option.getOrUndefined(inspection.parent)?.spanId).toBe(operation.spanId);
  expect(inspection.traceId).toBe(operation.traceId);
  expect(spans.map((span) => span.status._tag)).toEqual(["Ended", "Ended"]);
});
