import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { GlobalAppError } from "@lando/sdk/errors";
import { GlobalConfig, PluginManifest, type ServiceConfig } from "@lando/sdk/schema";
import { ConfigService, PathsService, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { emptyGlobalPolicy, prepareGlobalPolicy } from "../../src/global-app/enablement.ts";
import { readGlobalResolution, withGlobalResolutionCapabilities } from "../../src/global-app/resolution.ts";
import { GlobalPluginManifests } from "../../src/plugins/global-manifests.ts";
import {
  type PendingGlobalServiceContribution,
  assertEffectiveGlobalServices,
  assertGlobalResolution,
  resolveEffectiveGlobalServices,
  resolveGlobalServices,
} from "../../src/services/global-services.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const capability = TestRuntimeProvider.capabilities;
const contribution = (
  id: string,
  options: Partial<PendingGlobalServiceContribution["contribution"]> = {},
): PendingGlobalServiceContribution => ({ plugin: "@example/global", contribution: { id, ...options } });
const service = (dependsOn: ServiceConfig["dependsOn"] = []): ServiceConfig => ({
  type: "compose",
  image: "example:1",
  dependsOn,
});
const resolve = (
  contributions: ReadonlyArray<PendingGlobalServiceContribution>,
  configs: Readonly<Record<string, ServiceConfig>> = {},
  options: Partial<Parameters<typeof resolveGlobalServices>[0]> = {},
) =>
  resolveGlobalServices({
    contributions,
    policy: emptyGlobalPolicy(),
    providerCapabilities: capability,
    providerId: "test",
    loadServiceConfig: (entry) => Effect.succeed(configs[entry.contribution.id] ?? service()),
    ...options,
  });

describe("one global contribution eligibility resolver", () => {
  test("disabled policy and known unsupported capabilities exclude only owned current ids", async () => {
    const owned = contribution("blocked", { requires: { providerCapabilities: ["sharedCrossAppNetwork"] } });
    const old = await Effect.runPromise(
      prepareGlobalPolicy(emptyGlobalPolicy(), [contribution("old-id")], {
        selectors: ["old-id"],
        enabled: false,
      }),
    );
    const resolution = await Effect.runPromise(
      resolve(
        [owned],
        {},
        { policy: old.policy, providerCapabilities: { ...capability, sharedCrossAppNetwork: false } },
      ),
    );
    expect(resolution.entries[0]).toMatchObject({
      enabled: true,
      state: "blocked",
      reasons: ["capability-missing:sharedCrossAppNetwork"],
      dependencyEvidence: "unavailable",
    });
    expect(resolution.services).toEqual({});
    expect(resolution.excludedIds).toEqual(["blocked"]);
    expect(resolution.excludedIds).not.toContain("old-id");
    await Effect.runPromise(assertGlobalResolution(resolution));
  });

  test("missing offline declarations are unverified and actual runtime capabilities can admit them", async () => {
    let loads = 0;
    const owned = contribution("networked", {
      requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
    });
    const input = {
      contributions: [owned],
      policy: emptyGlobalPolicy(),
      providerId: "external",
      loadServiceConfig: () => {
        loads++;
        return Effect.succeed(service());
      },
    };
    const offline = await Effect.runPromise(resolveGlobalServices(input));
    expect(offline.entries[0]).toMatchObject({
      state: "unverified",
      capabilitySource: "unavailable",
      reasons: ["capability-unverified:sharedCrossAppNetwork"],
    });
    expect(offline.excludedIds).toEqual(["networked"]);
    expect(loads).toBe(0);
    const runtime = await Effect.runPromise(
      resolveGlobalServices({
        ...input,
        providerCapabilities: { ...capability, sharedCrossAppNetwork: true },
      }),
    );
    expect(runtime.entries[0]).toMatchObject({
      state: "enabled",
      capabilitySource: "runtime",
      dependencyEvidence: "resolved",
    });
    expect(Object.keys(runtime.services)).toEqual(["networked"]);
    expect(loads).toBe(1);
  });

  test("disabled and unsupported modules are never evaluated", async () => {
    const contributions = [
      contribution("disabled", { enabledByDefault: false }),
      contribution("blocked", { requires: { providerCapabilities: ["sharedCrossAppNetwork"] } }),
    ];
    const result = await Effect.runPromise(
      resolve(
        contributions,
        {},
        {
          providerCapabilities: { ...capability, sharedCrossAppNetwork: false },
          loadServiceConfig: () => Effect.die("excluded module evaluated"),
        },
      ),
    );
    expect(result.excludedIds).toEqual(["blocked", "disabled"]);
    expect(result.errors).toEqual([]);
  });

  test("required catalog dependencies propagate disabled and blocked state transitively", async () => {
    const contributions = [
      contribution("diagnostics", { enabledByDefault: false }),
      contribution("router"),
      contribution("consumer"),
    ];
    const configs = {
      router: service([{ service: "diagnostics", required: true, condition: "service_healthy" }]),
      consumer: service([{ service: "router", condition: "service_started" }]),
    };
    const result = await Effect.runPromise(resolve(contributions, configs));
    expect(result.entries.find((row) => row.id === "router")).toMatchObject({
      state: "blocked",
      dependencyEvidence: "resolved",
      requiredServices: ["diagnostics"],
      reasons: ["dependency-unavailable:diagnostics"],
    });
    expect(result.entries.find((row) => row.id === "consumer")?.state).toBe("blocked");
    expect(result.services).toEqual({});
    expect(Object.keys(result.composableServices).sort()).toEqual(["consumer", "router"]);
    expect(result.directlyExcludedIds).toEqual(["diagnostics"]);
    await Effect.runPromise(assertGlobalResolution(result, undefined, { directOnly: true }));
    const checked = await Effect.runPromise(Effect.result(assertGlobalResolution(result, ["router"])));
    expect(checked._tag).toBe("Failure");
  });

  test("optional and independently authored dependencies are left to ordinary planning", async () => {
    const result = await Effect.runPromise(
      resolve([contribution("disabled", { enabledByDefault: false }), contribution("consumer")], {
        consumer: service([
          { service: "disabled", required: false },
          { service: "custom-authored", required: true },
        ]),
      }),
    );
    expect(result.entries.find((row) => row.id === "consumer")).toMatchObject({
      state: "enabled",
      requiredServices: ["custom-authored"],
    });
    expect(Object.keys(result.services)).toEqual(["consumer"]);
  });

  for (const providerCapabilities of [undefined, { ...capability, sharedCrossAppNetwork: false }]) {
    test(`capability ${providerCapabilities === undefined ? "unverified" : "blocked"} dependencies retain valid enable intent transitively`, async () => {
      const result = await Effect.runPromise(
        resolveGlobalServices({
          contributions: [
            contribution("diagnostics", { requires: { providerCapabilities: ["sharedCrossAppNetwork"] } }),
            contribution("router"),
            contribution("consumer"),
          ],
          policy: emptyGlobalPolicy(),
          providerId: "test",
          ...(providerCapabilities === undefined ? {} : { providerCapabilities }),
          loadServiceConfig: (entry) =>
            Effect.succeed(
              service([{ service: entry.contribution.id === "consumer" ? "router" : "diagnostics" }]),
            ),
        }),
      );
      expect(result.excludedIds).toEqual(["consumer", "diagnostics", "router"]);
      expect(result.entries.find((row) => row.id === "router")).toMatchObject({
        state: "blocked",
        requiredServices: ["diagnostics"],
        dependencyEvidence: "resolved",
      });
      expect(result.errors).toEqual([]);
      await Effect.runPromise(assertGlobalResolution(result));
      const effective = resolveEffectiveGlobalServices(result, result.composableServices);
      expect(effective.services).toEqual({});
      expect(effective.errors).toEqual([]);
      await Effect.runPromise(assertEffectiveGlobalServices(result, result.composableServices));
    });
  }

  test("effective authored dependencies can repair provisional module graphs", async () => {
    const result = await Effect.runPromise(
      resolve([contribution("diagnostics", { enabledByDefault: false }), contribution("router")], {
        router: service([{ service: "diagnostics" }]),
      }),
    );
    const composed = { router: service([]) };
    expect(result.services).toEqual({});
    expect(resolveEffectiveGlobalServices(result, composed).services).toEqual(composed);
    await Effect.runPromise(assertEffectiveGlobalServices(result, composed));
  });

  test("effective graphs validate authored missing required dependencies and cycles", async () => {
    const result = await Effect.runPromise(resolve([]));
    const missing = resolveEffectiveGlobalServices(result, {
      authored: service([{ service: "missing" }]),
      optional: service([{ service: "missing", required: false }]),
    });
    expect(Object.keys(missing.services)).toEqual(["optional"]);
    expect(missing.errors[0]).toMatchObject({ id: "authored", kind: "dependency" });
    const cycle = resolveEffectiveGlobalServices(result, {
      a: service([{ service: "b" }]),
      b: service([{ service: "a" }]),
    });
    expect(cycle.services).toEqual({});
    expect(cycle.errors).toHaveLength(2);
  });

  test("required dependency cycles are explained and excluded", async () => {
    const result = await Effect.runPromise(
      resolve([contribution("a"), contribution("b"), contribution("independent")], {
        a: service([{ service: "b" }]),
        b: service([{ service: "a" }]),
      }),
    );
    expect(
      result.entries
        .find((row) => row.id === "a")
        ?.reasons.some((reason) => reason.startsWith("dependency-cycle:")),
    ).toBe(true);
    expect(result.entries.find((row) => row.id === "b")?.state).toBe("blocked");
    expect(Object.keys(result.services)).toEqual(["independent"]);
    expect(result.errors.filter((issue) => issue.kind === "cycle")).toHaveLength(2);
    expect(Object.keys(result.composableServices).sort()).toEqual(["a", "b", "independent"]);
    expect(result.directlyExcludedIds).toEqual([]);
  });

  test("a failed module retains its original error without hiding independent configuration", async () => {
    const original = new GlobalAppError({
      operation: "module",
      message: "broken module",
      remediation: "Repair the module.",
    });
    const result = await Effect.runPromise(
      resolve(
        [contribution("broken"), contribution("working")],
        {},
        {
          loadServiceConfig: (entry) =>
            entry.contribution.id === "broken" ? Effect.fail(original) : Effect.succeed(service()),
        },
      ),
    );
    expect(Object.keys(result.services)).toEqual(["working"]);
    expect(result.errors[0]?.cause).toBe(original);
    const selected = await Effect.runPromise(Effect.result(assertGlobalResolution(result, ["working"])));
    expect(selected._tag).toBe("Success");
    const all = await Effect.runPromise(Effect.result(assertGlobalResolution(result)));
    expect(all._tag).toBe("Failure");
    if (all._tag === "Failure") expect(all.failure).toBe(original);
  });

  test("unexpected module defects become isolated errors while interruption remains cancellation", async () => {
    const result = await Effect.runPromise(
      resolve(
        [contribution("broken"), contribution("working")],
        {},
        {
          loadServiceConfig: (entry) =>
            entry.contribution.id === "broken"
              ? Effect.die("unexpected plugin failure")
              : Effect.succeed(service()),
        },
      ),
    );
    expect(Object.keys(result.services)).toEqual(["working"]);
    expect(result.errors[0]?.cause).toBeInstanceOf(GlobalAppError);
    const canceled = await Effect.runPromiseExit(
      resolve([contribution("canceled")], {}, { loadServiceConfig: () => Effect.interrupt }),
    );
    expect(Exit.isFailure(canceled)).toBe(true);
    if (Exit.isFailure(canceled)) expect(Cause.hasInterrupts(canceled.cause)).toBe(true);
  });

  test("direct contribution inputs cannot bypass globally unique owner validation", async () => {
    const outcome = await Effect.runPromise(
      Effect.result(
        resolve([contribution("shared"), { plugin: "different-owner", contribution: { id: "shared" } }]),
      ),
    );
    expect(outcome._tag).toBe("Failure");
    if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("GlobalServiceCollisionError");
  });

  test("conflicts are rejected before either module is evaluated", async () => {
    const result = await Effect.runPromise(
      resolve(
        [contribution("a", { conflicts: ["b"] }), contribution("b")],
        {},
        { loadServiceConfig: () => Effect.die("conflicting module evaluated") },
      ),
    );
    expect(result.excludedIds).toEqual(["a", "b"]);
    expect(result.errors.filter((issue) => issue.kind === "conflict")).toHaveLength(2);
  });
});

const withRegistry = async <A>(
  run: (
    layer: Layer.Layer<
      PluginRegistry | PathsService | ConfigService | import("@lando/sdk/services").StateStore
    >,
  ) => Promise<A>,
  declared = true,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "global-resolution-"));
  try {
    const module = join(root, "service.ts");
    await Bun.write(
      module,
      `export default (await import(${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))})).Effect.succeed({type:"compose",image:"example:1"});`,
    );
    const manifest = Schema.decodeUnknownSync(PluginManifest)({
      name: "@example/global",
      version: "1.0.0",
      api: 4,
      contributes: {
        globalServices: [
          { id: "networked", module, requires: { providerCapabilities: ["sharedCrossAppNetwork"] } },
        ],
      },
    });
    const registry = PluginRegistry.of({
      ...(declared
        ? { declaredProviderCapabilities: () => ({ ...capability, sharedCrossAppNetwork: false }) }
        : {}),
      list: Effect.succeed([manifest]),
      load: () => Effect.die("not used"),
      loadServiceType: () => Effect.die("not used"),
      loadServiceFeature: () => Effect.die("not used"),
      loadAppFeature: () => Effect.die("not used"),
    });
    const config = Schema.decodeUnknownSync(GlobalConfig)({ defaultProviderId: "test" });
    const layer = Layer.mergeAll(
      makeTestStateStore().layer,
      Layer.succeed(
        PathsService,
        makeLandoPaths({ userConfRoot: join(root, "conf"), userDataRoot: join(root, "data") }),
      ),
      Layer.succeed(PluginRegistry, registry),
      Layer.succeed(ConfigService, {
        load: Effect.succeed(config),
        get: (key) => Effect.succeed(config[key]),
      }),
    );
    return await run(layer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("offline resolution uses declared provider metadata without a RuntimeProviderRegistry", async () => {
  await withRegistry(async (layer) => {
    const result = await Effect.runPromise(readGlobalResolution().pipe(Effect.provide(layer)));
    expect(result.entries[0]).toMatchObject({ state: "blocked", capabilitySource: "declared" });
    expect(result.excludedIds).toEqual(["networked"]);
  });
});

test("runtime capability evidence feeds the same resolver without permanently blocking unknown declarations", async () => {
  await withRegistry(async (layer) => {
    const offline = await Effect.runPromise(readGlobalResolution().pipe(Effect.provide(layer)));
    expect(offline.entries[0]?.state).toBe("unverified");
    const runtime = await Effect.runPromise(
      withGlobalResolutionCapabilities(
        "test",
        { ...capability, sharedCrossAppNetwork: true },
        readGlobalResolution(),
      ).pipe(Effect.provide(layer)),
    );
    expect(runtime.entries[0]?.state).toBe("enabled");
    const scopedElsewhere = await Effect.runPromise(
      withGlobalResolutionCapabilities(
        "different",
        { ...capability, sharedCrossAppNetwork: true },
        readGlobalResolution(),
      ).pipe(Effect.provide(layer)),
    );
    expect(scopedElsewhere.entries[0]?.state).toBe("unverified");
  }, false);
});

test("host global manifests prevent app-local contributions from leaking into global policy", async () => {
  await withRegistry(async (layer) => {
    const result = await Effect.runPromise(
      readGlobalResolution().pipe(
        Effect.provide(layer),
        Effect.provideService(GlobalPluginManifests, { list: Effect.succeed([]) }),
      ),
    );
    expect(result.entries).toEqual([]);
  });
});

test("explicit candidate policy leaves durable intent unchanged", async () => {
  await withRegistry(async (layer) => {
    const candidate = (
      await Effect.runPromise(
        prepareGlobalPolicy(emptyGlobalPolicy(), [contribution("networked")], {
          selectors: ["networked"],
          enabled: false,
        }),
      )
    ).policy;
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const explicit = yield* readGlobalResolution({ policy: candidate });
        const durable = yield* readGlobalResolution();
        return { explicit, durable };
      }).pipe(Effect.provide(layer)),
    );
    expect(rows.explicit.entries[0]?.state).toBe("disabled");
    expect(rows.durable.entries[0]?.state).toBe("blocked");
    expect(rows.durable.policy).toEqual(emptyGlobalPolicy());
  });
});
