import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";

import { RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { bundledPluginModules } from "@lando/engine/composition";
import { PluginContributionGraph } from "@lando/engine/plugins/contribution-graph";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { GlobalConfigSources } from "@lando/engine/services/config";
import { ProviderId } from "@lando/sdk/schema";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap.ts";
import { DoctorReportSchema } from "../../src/cli/commands/doctor-report-contract.ts";
import { doctor } from "../../src/cli/commands/doctor.ts";
import { type LandoRuntimeOptions, makeLandoRuntime } from "../../src/runtime/layer.ts";

const report = '{ name: "installed-healthy", status: "pass", severity: "info", context: {}, solutions: [] }';
const healthy = `{ id: "installed-healthy", run: () => Effect.succeed([${report}]) }`;
const registry = Layer.succeed(
  RuntimeProviderRegistry,
  RuntimeProviderRegistry.of({
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
    capabilities: Effect.succeed({
      ...TestRuntimeProvider.capabilities,
      bindMountPerformance: "slow",
      fileSyncTargets: "prepared-volume",
    }),
    select: () =>
      Effect.succeed({
        ...TestRuntimeProvider,
        capabilities: {
          ...TestRuntimeProvider.capabilities,
          bindMountPerformance: "slow",
          fileSyncTargets: "prepared-volume",
        },
      }),
  }),
);

const installedRuntime = (root: string, disabled = false) =>
  makeLandoRuntime({
    bootstrap: "plugins",
    configSources: { user: false, env: false },
    config: {
      userDataRoot: root,
      userConfRoot: join(root, "config"),
      userCacheRoot: join(root, "cache"),
    },
    plugins: {
      externalImports: true,
      discovery: { bundled: false, system: false, user: true, app: false },
      disable: disabled ? ["@example/doctor-installed"] : [],
    },
  } satisfies LandoRuntimeOptions).pipe(Layer.merge(registry));

const withInstalled = async <A>(
  source: string,
  run: (runtime: ReturnType<typeof installedRuntime>, root: string) => Promise<A>,
  disabled = false,
) => {
  const root = await mkdtemp(join(tmpdir(), "doctor-installed-contributions-"));
  const name = "@example/doctor-installed";
  const packageRoot = join(root, "plugins", name, "1.0.0");
  const manifest = { name, version: "1.0.0", api: 4, entry: "index.js" };
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(root, "plugins", "registry.json"),
      JSON.stringify({ [name]: { name, version: "1.0.0", path: packageRoot } }),
    );
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ landoPlugin: manifest }));
    await writeFile(
      join(packageRoot, "index.js"),
      `import { Effect } from "effect";\n${source.replaceAll("MANIFEST", JSON.stringify(manifest))}\n`,
    );
    const runtime = installedRuntime(root, disabled);
    return await run(runtime, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const collect = (runtime: ReturnType<typeof installedRuntime>, env: Readonly<Record<string, string>> = {}) =>
  Effect.runPromise(
    doctor({ env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000", ...env } }).pipe(Effect.provide(runtime)),
  );

describe("doctor installed contributions through runtime discovery", () => {
  for (const [label, source] of [
    ["direct named export", `export const doctorChecks = [${healthy}];`],
    [
      "plugin descriptor export",
      `export const plugin = { name: "@example/doctor-installed", manifest: MANIFEST, doctorChecks: [${healthy}] };`,
    ],
  ] as const) {
    test(`runs a ${label} from the contribution graph`, () =>
      withInstalled(source, async (runtime) => {
        const result = await collect(runtime);
        expect(result.checks.some((check) => check.name === "installed-healthy")).toBe(true);
        expect(() =>
          Schema.encodeSync(DoctorReportSchema)({
            version: "test",
            provider: result,
            self: { checks: result.selfChecks ?? [] },
            subsystems: { checks: [] },
            globalApp: { checks: [] },
            mcp: { checks: [] },
          }),
        ).not.toThrow();
      }));
  }

  test("an explicitly empty modules override suppresses discovered checks", () =>
    withInstalled(`export const doctorChecks = [${healthy}];`, async (runtime) => {
      const result = await Effect.runPromise(doctor({}, []).pipe(Effect.provide(runtime)));
      expect(result.checks.some((check) => check.name === "installed-healthy")).toBe(false);
    }));

  test("disabled plugins produce an empty graph and their checks never run", () =>
    withInstalled(
      'export const doctorChecks = [{ id: "disabled", run: () => { throw new Error("disabled ran"); } }];',
      async (runtime) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            expect((yield* PluginContributionGraph).plugins).toHaveLength(0);
            return yield* doctor({ env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } });
          }).pipe(Effect.provide(runtime)),
        );
        expect(result.selfChecks?.some((check) => check.section.startsWith("plugin-check:")) ?? false).toBe(
          false,
        );
        expect(result.checks.some((check) => check.name === "selected-provider")).toBe(true);
      },
      true,
    ));

  for (const [label, source] of [
    ["duplicate ids", `export const doctorChecks = [${healthy}, ${healthy}];`],
    ["malformed collection", 'export const doctorChecks = "invalid";'],
    ["malformed run", 'export const doctorChecks = [{ id: "bad", run: 42 }];'],
    ["malformed relevant", `export const doctorChecks = [{ ...${healthy}, relevant: false }];`],
    [
      "wrong identity",
      `export const plugin = { name: "@example/other", manifest: MANIFEST, doctorChecks: [${healthy}] };`,
    ],
    [
      "throwing getter",
      'export const plugin = { name: "@example/doctor-installed", manifest: MANIFEST, get doctorChecks() { throw new Error("private payload"); } };',
    ],
  ] as const) {
    test(`isolates ${label} as a schema-valid self failure`, () =>
      withInstalled(source, async (runtime) => {
        const result = await collect(runtime);
        expect(result.checks.some((check) => check.name === "installed-healthy")).toBe(false);
        expect(result.selfChecks).toContainEqual(
          expect.objectContaining({
            section: "plugin-doctor-checks",
            context: expect.objectContaining({
              failure: "PluginDescriptorMismatchError",
              message: expect.stringContaining("@example/doctor-installed"),
            }),
          }),
        );
        expect(JSON.stringify(result)).not.toContain("private payload");
        expect(() =>
          Schema.encodeSync(DoctorReportSchema)({
            version: "test",
            provider: result,
            self: { checks: result.selfChecks ?? [] },
            subsystems: { checks: [] },
            globalApp: { checks: [] },
            mcp: { checks: [] },
          }),
        ).not.toThrow();
      }));
  }

  test("isolates hung and throwing checks while a healthy sibling completes", () =>
    withInstalled(
      `export const doctorChecks = [${healthy}, { id: "hung", run: () => Effect.never }, { id: "throwing", run: () => { throw new Error("Authorization: Bearer installed-secret"); } }];`,
      async (runtime) => {
        const result = await collect(runtime, { PLUGIN_API_TOKEN: "installed-secret" });
        expect(result.checks.some((check) => check.name === "installed-healthy")).toBe(true);
        expect(result.selfChecks).toContainEqual(
          expect.objectContaining({ section: "plugin-check:hung", reason: "timeout" }),
        );
        expect(result.selfChecks).toContainEqual(
          expect.objectContaining({ section: "plugin-check:throwing", reason: "defect" }),
        );
        expect(JSON.stringify(result)).not.toContain("installed-secret");
        expect(() =>
          Schema.encodeSync(DoctorReportSchema)({
            version: "test",
            provider: result,
            self: { checks: result.selfChecks ?? [] },
            subsystems: { checks: [] },
            globalApp: { checks: [] },
            mcp: { checks: [] },
          }),
        ).not.toThrow();
      },
    ));
  test("an empty graph suppresses bundled checks even when they would report", () =>
    withInstalled(
      `export const doctorChecks = [${healthy}];`,
      async (runtime) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const control = yield* doctor(
              { platform: "win32", env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } },
              bundledPluginModules(),
            );
            expect(control.checks.some((check) => check.name === "file-sync")).toBe(true);
            return yield* doctor({ env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } });
          }).pipe(Effect.provide(runtime)),
        );
        expect(result.checks.some((check) => check.name === "file-sync")).toBe(false);
      },
      true,
    ));

  test("the resilient report retains installed graph contributions", () =>
    withInstalled(`export const doctorChecks = [${healthy}];`, async (_runtime, root) => {
      const factory = Layer.succeed(RuntimeLayerFactory, RuntimeLayerFactory.of({ make: makeLandoRuntime }));
      const sources = Layer.succeed(
        GlobalConfigSources,
        GlobalConfigSources.of({
          env: {},
          sources: { user: false, env: false },
          rootOverrides: {
            userDataRoot: root,
            userConfRoot: join(root, "config"),
            userCacheRoot: join(root, "cache"),
            systemPluginRoot: join(root, "system-plugins"),
          },
        }),
      );
      const result = await Effect.runPromise(
        resilientDoctorReport({ env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } }).pipe(
          Effect.provide(Layer.merge(factory, sources)),
        ),
      );
      expect(result.provider.checks.some((check) => check.name === "installed-healthy")).toBe(true);
      expect(() => Schema.encodeSync(DoctorReportSchema)(result)).not.toThrow();
    }));

  test("runtime construction does not inspect or run doctor callbacks", () =>
    withInstalled(
      `export const plugin = { name: "@example/doctor-installed", manifest: MANIFEST, get doctorChecks() { throw new Error("doctor slot eagerly read"); } };`,
      async (runtime) => {
        const names = await Effect.runPromise(
          Effect.map(PluginContributionGraph, (graph) =>
            graph.plugins.map((plugin) => String(plugin.manifest.name)),
          ).pipe(Effect.provide(runtime)),
        );
        expect(names).toEqual(["@example/doctor-installed"]);
      },
    ));
});
