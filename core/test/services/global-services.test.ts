import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { GlobalAppError, GlobalServiceCollisionError } from "@lando/sdk/errors";
import {
  type GlobalServiceContribution,
  PluginManifest,
  type ProviderCapabilities,
  type ServiceConfig,
} from "@lando/sdk/schema";

import {
  materializeGlobalServices,
  resolveGlobalServiceContributions,
} from "../../src/services/global-services.ts";

const capabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: false,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
  ...overrides,
});

const manifest = (
  name: string,
  globalServices: ReadonlyArray<GlobalServiceContribution>,
): typeof PluginManifest.Type =>
  Schema.decodeSync(PluginManifest)({
    name,
    version: "1.0.0",
    api: 4,
    contributes: { globalServices },
  });

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected typed failure");
  return failure.value;
};

describe("global service contribution resolution", () => {
  test("returns id-sorted distinct contributions across two plugins", async () => {
    const resolved = await Effect.runPromise(
      resolveGlobalServiceContributions([
        manifest("@lando/zeta", [{ id: "zeta", module: "/tmp/zeta.mjs" }]),
        manifest("@lando/alpha", [{ id: "alpha", module: "/tmp/alpha.mjs" }]),
      ]),
    );

    expect(resolved.map((entry) => entry.contribution.id)).toEqual(["alpha", "zeta"]);
    expect(resolved.map((entry) => entry.plugin)).toEqual(["@lando/alpha", "@lando/zeta"]);
  });

  test("lets the same plugin redeclare the same id with last-wins semantics", async () => {
    const resolved = await Effect.runPromise(
      resolveGlobalServiceContributions([
        manifest("@lando/redeclare", [
          { id: "fakegs", module: "/tmp/first.mjs", summary: "first" },
          { id: "fakegs", module: "/tmp/second.mjs", summary: "second" },
        ]),
      ]),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.contribution.module).toBe("/tmp/second.mjs");
    expect(resolved[0]?.contribution.summary).toBe("second");
  });

  test("fails when two different plugins contribute the same id", async () => {
    const exit = await Effect.runPromiseExit(
      resolveGlobalServiceContributions([
        manifest("@lando/zeta", [{ id: "shared", module: "/tmp/zeta.mjs" }]),
        manifest("@lando/alpha", [{ id: "shared", module: "/tmp/alpha.mjs" }]),
      ]),
    );
    const failure = failureOf(exit);

    expect(failure).toBeInstanceOf(GlobalServiceCollisionError);
    if (!(failure instanceof GlobalServiceCollisionError)) throw new Error("expected collision error");
    expect(failure.id).toBe("shared");
    expect([...failure.plugins]).toEqual(["@lando/alpha", "@lando/zeta"]);
    expect(failure.message).toContain("@lando/alpha");
    expect(failure.message).toContain("@lando/zeta");
  });
});

describe("global service materialization", () => {
  test("drops capability-rejected and disabled contributions and returns an id-sorted service map", async () => {
    const loaded: string[] = [];
    const loadServiceConfig = (entry: { readonly contribution: { readonly id: string } }) => {
      loaded.push(entry.contribution.id);
      return Effect.succeed({ api: 4, type: "lando" } satisfies ServiceConfig);
    };

    const services = await Effect.runPromise(
      materializeGlobalServices({
        manifests: [
          manifest("@lando/zeta", [
            {
              id: "zeta",
              module: "/tmp/zeta.mjs",
              requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
            },
            { id: "disabled", module: "/tmp/disabled.mjs", enabledByDefault: false },
          ]),
          manifest("@lando/alpha", [
            { id: "beta", module: "/tmp/beta.mjs", requires: { providerCapabilities: ["routeProvider"] } },
            { id: "alpha", module: "/tmp/alpha.mjs" },
          ]),
        ],
        providerCapabilities: capabilities({ sharedCrossAppNetwork: true, routeProvider: false }),
        providerId: "lando",
        loadServiceConfig,
      }),
    );

    expect(Object.keys(services)).toEqual(["alpha", "zeta"]);
    expect(services).toEqual({
      alpha: { api: 4, type: "lando" },
      zeta: { api: 4, type: "lando" },
    });
    expect(loaded).toEqual(["alpha", "zeta"]);
  });

  test("surfaces loader failures as GlobalAppError", async () => {
    const exit = await Effect.runPromiseExit(
      materializeGlobalServices({
        manifests: [manifest("@lando/failing", [{ id: "fakegs", module: "/tmp/failing.mjs" }])],
        providerCapabilities: capabilities(),
        providerId: "lando",
        loadServiceConfig: () =>
          Effect.fail(
            new GlobalAppError({
              message: "loader failed",
              operation: "regenerateDist",
            }),
          ),
      }),
    );

    expect(failureOf(exit)).toBeInstanceOf(GlobalAppError);
  });
});
