import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { ServiceName } from "@lando/sdk/schema";
import { PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { planApp } from "../../src/planner/assemble.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";

test("planApp resolves each service exactly once", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-resolution-once-"));
  const calls = new Map<string, number>();
  const serviceType: ServiceType = {
    id: "counted",
    name: "counted",
    base: "l337",
    schema: Schema.Unknown,
    resolve: (input) =>
      Effect.sync(() => {
        calls.set(input.name, (calls.get(input.name) ?? 0) + 1);
        return {
          base: "l337" as const,
          normalizedConfig: input.service,
          features: [],
          tooling: { inspect: { cmd: "inspect" } },
        };
      }),
  };
  const landofile = rememberLandofileAppRoot(
    {
      name: "counted",
      services: {
        [ServiceName.make("web")]: { type: "counted", home: false as const },
        [ServiceName.make("worker")]: { type: "counted", home: false as const },
      },
      events: { "pre-inspect": ["echo ready"] },
    },
    root,
  );
  try {
    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry;
        return yield* planApp(
          { ...registry, loadServiceType: () => Effect.succeed(serviceType) },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          landofile,
          TestRuntimeProvider.capabilities,
        );
      }).pipe(Effect.provide(PluginRegistryLive)),
    );
    // Then
    expect([...calls]).toEqual([
      ["web", 1],
      ["worker", 1],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
