import { describe, expect, test } from "bun:test";

import { Cause, Context, DateTime, Effect, Exit, Schema } from "effect";

import { attachEffectiveTooling } from "@lando/engine/planner/effective-tooling";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { PluginDescriptorMismatchError, ToolingCommandLookupError } from "@lando/sdk/errors";
import type { ExecutableCommandLoader, ExecutableCommandSpec } from "@lando/sdk/plugins";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { resolveEventCommandTarget } from "../../src/cli/event-command-target.ts";

const builtInEntry = builtInCommandEntries.find((entry) => entry.spec.id === "app:start");
if (builtInEntry === undefined) throw new Error("Missing built-in app:start command entry.");

const makePlan = (): AppPlan =>
  attachEffectiveTooling(
    {
      id: AppId.make("demo"),
      name: "demo",
      slug: "demo",
      root: AbsolutePath.make("/workspace/demo"),
      provider: ProviderId.make("test"),
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata: {
        resolvedAt: DateTime.unsafeMake("2026-01-01T00:00:00.000Z"),
        source: "/tmp/.lando.yml",
        runtime: 4 as const,
      },
      extensions: {},
    },
    { lint: { cmds: ["bun run lint"], description: "Run lint" } },
  );

const makePluginSpec = (id = "db:import", namespace = "db"): ExecutableCommandSpec => ({
  id,
  summary: "Import a database dump.",
  namespace,
  bootstrap: "app",
  flags: {},
  args: {},
  strict: false,
  run: () => Effect.void,
  resultSchema: Schema.Unknown,
});

const makeRuntimeContext = (id: string, load: ExecutableCommandLoader): Context.Context<never> =>
  Context.add(Context.empty(), PluginContributionGraph, {
    plugins: [],
    certificateAuthorities: [],
    commands: [{ id, pluginName: "example-plugin", source: "system", load }],
    hostContext: Context.empty(),
  });

describe("resolveEventCommandTarget", () => {
  test("resolves a built-in target without weakening its command spec", async () => {
    // Given
    const effect = resolveEventCommandTarget("app:start", Context.empty(), [builtInEntry]);

    // When
    const target = await Effect.runPromise(effect);

    // Then
    expect(target.kind).toBe("built-in");
    expect(target.spec.id).toBe("app:start");
    expect(target.spec).toBe(builtInEntry.inputSpec ?? builtInEntry.spec);
  });

  test("classifies plugin-owned commands even when they share a core namespace", async () => {
    // Given
    const spec = makePluginSpec("meta:example:hello", "meta");
    const context = makeRuntimeContext(spec.id, () => Promise.resolve(spec));

    // When
    const target = await Effect.runPromise(
      resolveEventCommandTarget("meta:example:hello", context, [builtInEntry]),
    );

    // Then
    expect(target.kind).toBe("plugin");
    expect(target.spec.id).toBe("meta:example:hello");
  });

  test("resolves only an exact app tooling target", async () => {
    // Given
    const plan = makePlan();

    // When
    const target = await Effect.runPromise(
      resolveEventCommandTarget("app:lint", Context.empty(), [builtInEntry], plan),
    );

    // Then
    expect(target.kind).toBe("tooling");
    expect(target.spec.id).toBe("app:lint");
  });

  test("resolves a namespaced app tooling target", async () => {
    // Given
    const plan = attachEffectiveTooling(makePlan(), {
      "db:wait": { cmds: ["db-ready"], description: "Wait for the database" },
    });

    // When
    const target = await Effect.runPromise(
      resolveEventCommandTarget("app:db:wait", Context.empty(), [builtInEntry], plan),
    );

    // Then
    expect(target.kind).toBe("tooling");
    expect(target.spec.id).toBe("app:db:wait");
  });

  test("caches a validated plugin loader after the first resolution", async () => {
    // Given
    let calls = 0;
    const loader: ExecutableCommandLoader = () => {
      calls += 1;
      return Promise.resolve(makePluginSpec());
    };
    const context = makeRuntimeContext("db:import", loader);

    // When
    await Effect.runPromise(resolveEventCommandTarget("db:import", context, [builtInEntry]));
    await Effect.runPromise(resolveEventCommandTarget("db:import", context, [builtInEntry]));

    // Then
    expect(calls).toBe(1);
  });

  test("revalidates a cached plugin spec against each declared command id", async () => {
    // Given
    const loader: ExecutableCommandLoader = () => Promise.resolve(makePluginSpec("db:import"));
    const importContext = makeRuntimeContext("db:import", loader);
    const exportContext = makeRuntimeContext("db:export", loader);

    // When
    await Effect.runPromise(resolveEventCommandTarget("db:import", importContext, [builtInEntry]));
    const exit = await Effect.runPromiseExit(
      resolveEventCommandTarget("db:export", exportContext, [builtInEntry]),
    );

    // Then
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(error).toBeInstanceOf(PluginDescriptorMismatchError);
    if (error instanceof PluginDescriptorMismatchError) {
      expect(error.declared).toContain("id=db:export");
      expect(error.provided).toContain("id=db:import");
    }
  });

  test("does not cache a plugin spec that fails descriptor validation", async () => {
    // Given
    let calls = 0;
    const loader: ExecutableCommandLoader = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(
            JSON.parse(
              '{"id":"db:ship","summary":"Ship","namespace":"wrong","bootstrap":"bogus","run":{},"resultSchema":null}',
            ),
          )
        : Promise.resolve(makePluginSpec());
    };
    const context = makeRuntimeContext("db:import", loader);

    // When
    const invalid = await Effect.runPromiseExit(
      resolveEventCommandTarget("db:import", context, [builtInEntry]),
    );
    const retry = await Effect.runPromiseExit(
      resolveEventCommandTarget("db:import", context, [builtInEntry]),
    );

    // Then
    expect(Exit.isFailure(invalid)).toBe(true);
    expect(Exit.isSuccess(retry)).toBe(true);
    expect(calls).toBe(2);
    const error = Exit.isFailure(invalid) ? Cause.squash(invalid.cause) : undefined;
    expect(error).toBeInstanceOf(PluginDescriptorMismatchError);
    if (error instanceof PluginDescriptorMismatchError) {
      expect(error.declared).toEqual([
        "id=db:import",
        "namespace=db",
        "bootstrap=valid",
        "resultSchema=schema",
      ]);
      expect(error.provided).toEqual([
        "id=db:ship",
        "namespace=wrong",
        "bootstrap=bogus",
        "resultSchema=non-schema",
      ]);
    }
  });

  test("rejects bare and unknown namespaced ids as tagged lookup misses", async () => {
    // Given
    const plan = makePlan();

    // When
    const bare = await Effect.runPromiseExit(
      resolveEventCommandTarget("lint", Context.empty(), [builtInEntry], plan),
    );
    const nestedTool = await Effect.runPromiseExit(
      resolveEventCommandTarget("app:lint:extra", Context.empty(), [builtInEntry], plan),
    );

    // Then
    const bareError = Exit.isFailure(bare) ? Cause.squash(bare.cause) : undefined;
    const nestedError = Exit.isFailure(nestedTool) ? Cause.squash(nestedTool.cause) : undefined;
    expect(bareError).toBeInstanceOf(ToolingCommandLookupError);
    expect(nestedError).toBeInstanceOf(ToolingCommandLookupError);
    if (bareError instanceof ToolingCommandLookupError) expect(bareError.targetKind).toBe("built-in");
    if (nestedError instanceof ToolingCommandLookupError) expect(nestedError.targetKind).toBe("tooling");
  });

  test("rejects a non-canonical id even when a plugin graph publishes it", async () => {
    // Given
    const spec = makePluginSpec("DB:import", "DB");
    const context = makeRuntimeContext(spec.id, () => Promise.resolve(spec));

    // When
    const exit = await Effect.runPromiseExit(resolveEventCommandTarget("DB:import", context, [builtInEntry]));

    // Then
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(error).toBeInstanceOf(ToolingCommandLookupError);
    if (error instanceof ToolingCommandLookupError) expect(error.targetKind).toBe("plugin");
  });
});
