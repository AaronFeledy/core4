import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledPluginModules } from "@lando/engine/composition";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { makeLandoPaths } from "@lando/paths";
import { definePlugin } from "@lando/sdk/plugins";
import { GlobalConfig, PluginManifest, ProviderId } from "@lando/sdk/schema";
import { ConfigService, FileSyncEngine, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { doctor } from "../../src/cli/commands/doctor.ts";

test.each([
  { name: "passthrough", defaultEngine: "passthrough", alternative: true, disabled: false, expected: false },
  { name: "alternative", defaultEngine: "alternative", alternative: true, disabled: false, expected: false },
  { name: "disabled Mutagen", defaultEngine: undefined, alternative: true, disabled: true, expected: false },
  { name: "selected Mutagen", defaultEngine: "mutagen", alternative: false, disabled: false, expected: true },
])("doctor only diagnoses the enabled selected engine ($name)", async (scenario) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-doctor-sync-policy-"));
  const paths = Layer.succeed(PathsService, makeLandoPaths({ platform: "win32", userDataRoot: root }));
  const modules = [
    ...bundledPluginModules(),
    ...(scenario.alternative
      ? [
          definePlugin({
            name: "@test/alternative-sync",
            manifest: Schema.decodeUnknownSync(PluginManifest)({
              name: "@test/alternative-sync",
              version: "1.0.0",
              api: 4,
              contributes: {
                fileSyncEngines: [
                  {
                    id: "alternative",
                    supports: { platform: ["win32"] },
                    capabilities: TestFileSyncEngine.capabilities,
                  },
                ],
              },
            }),
            fileSyncEngines: new Map([
              [
                "alternative",
                { make: () => Layer.succeed(FileSyncEngine, { ...TestFileSyncEngine, id: "alternative" }) },
              ],
            ]),
            doctorChecks: [
              {
                id: "alternative-sync",
                run: () =>
                  Effect.succeed([
                    {
                      name: "alternative-sync",
                      status: "pass",
                      severity: "info",
                      context: { engineId: "alternative" },
                      solutions: [],
                    },
                  ]),
              },
            ],
          }),
        ]
      : []),
  ];
  const graph = PluginContributionGraph.layer<never>(
    {
      layers: [],
      manifests: [],
      externalImports: false,
      cwd: root,
      discovery: {
        bundled: true,
        system: false,
        user: false,
        app: false,
        disable: scenario.disabled ? ["@lando/file-sync-mutagen"] : [],
      },
    },
    modules,
  ).pipe(Layer.provide(paths));
  const config = Schema.decodeUnknownSync(GlobalConfig)({
    defaultProviderId: "lando",
    userDataRoot: root,
    ...(scenario.defaultEngine === undefined ? {} : { defaultFileSyncEngine: scenario.defaultEngine }),
  });
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    capabilities: {
      ...TestRuntimeProvider.capabilities,
      bindMountPerformance: "slow" as const,
      fileSyncTargets: "prepared-volume" as const,
    },
  };
  const registry = RuntimeProviderRegistry.of({
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make("lando")]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  try {
    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        doctor().pipe(
          Effect.provide(
            Layer.mergeAll(
              paths,
              graph,
              Layer.succeed(ConfigService, {
                load: Effect.succeed(config),
                get: (key) => Effect.succeed(config[key]),
              }),
              Layer.succeed(RuntimeProviderRegistry, registry),
            ),
          ),
        ),
      ),
    );
    // Then
    expect(result.checks.some((check) => check.context.engineId === "mutagen")).toBe(scenario.expected);
    expect(result.checks.some((check) => check.context.engineId === "alternative")).toBe(
      scenario.alternative && scenario.defaultEngine !== "passthrough",
    );
    expect(result.selfChecks?.filter((check) => check.section === "plugin-doctor-checks") ?? []).toEqual([]);
    expect(result.selfChecks?.filter((check) => check.section === "file-sync-selection") ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
