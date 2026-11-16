import { expect, test } from "bun:test";
import { TestRuntimeProvider } from "@lando/core/testing";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as LandoConfigService from "@lando/engine/services/config";
import { RedactionService } from "@lando/redaction/service";
import { MalformedCliFlagValueError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, RuntimeProviderRegistry } from "@lando/sdk/services";
import * as StateStore from "@lando/state-store/service";
import { Context, Effect, Layer, Schema } from "effect";
import { inputDoctorOptions, metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor";
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns";
import { collectDoctorReport } from "../../src/cli/commands/doctor-report";
import {
  type DoctorContexts,
  configSection,
  independentSection,
  runtimeSection,
} from "../../src/cli/commands/doctor-sections";
import { validateCliFlagValues } from "../../src/cli/flag-value-validation";

const finding = (name: string) => ({
  checks: [{ name, status: "pass" as const, severity: "info" as const, context: {}, solutions: [] }],
});
const table = [
  independentSection({ id: "mcp", run: Effect.succeed(finding("independent")) }),
  configSection({
    id: "network-trust",
    run: ConfigService.pipe(
      Effect.flatMap((config) => config.load),
      Effect.as(finding("configured")),
    ),
  }),
  runtimeSection({ id: "provider", run: RuntimeProviderRegistry.pipe(Effect.as(finding("runtime"))) }),
];

const configLayer = Layer.mergeAll(StateStore.layer, HostDnsResolver.layer).pipe(
  Layer.provideMerge(LandoConfigService.layerWith({ env: {}, sources: { user: false, env: false } })),
);

test.each(["none", "config", "runtime"] as const)(
  "derives section skips with %s services available",
  async (availability) => {
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* Layer.build(configLayer);
        const registry = RuntimeProviderRegistry.of({
          list: Effect.succeed([]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.succeed(TestRuntimeProvider),
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
          appliedPlansFor: () => Effect.succeed([]),
        });
        const plugins = yield* Layer.build(PluginRegistryLayer.layer);
        const runtime = Context.merge(Context.add(config, RuntimeProviderRegistry, registry), plugins);
        const contexts: DoctorContexts =
          availability === "none" ? {} : availability === "config" ? { config } : { config, runtime };
        return yield* collectDoctorReport({ options: { env: {} }, contexts, table });
      }).pipe(Effect.scoped),
    );
    expect(report.checks.map((check) => check.name)).toEqual(
      availability === "none"
        ? ["independent"]
        : availability === "config"
          ? ["independent", "configured"]
          : ["independent", "configured", "runtime"],
    );
    expect(report.skipped).toEqual(
      availability === "none"
        ? [
            {
              section: "network-trust",
              reason: "Requires a valid global config; see the global-config check.",
            },
            { section: "provider", reason: "Requires a valid global config; see the global-config check." },
          ]
        : availability === "config"
          ? [
              {
                section: "provider",
                reason: "Requires the provider runtime; see the provider-bootstrap check.",
              },
            ]
          : [],
    );
  },
);

test("selection enables opt-in sections, retains table order, and omits unselected runs and skips", async () => {
  let unselectedRuns = 0;
  const report = await Effect.runPromise(
    collectDoctorReport({
      options: inputDoctorOptions({ flags: { section: ["deprecations", "mcp"] } }),
      contexts: {},
      initialChecks: [
        {
          section: "global-config",
          name: "global-config",
          status: "pass",
          severity: "info",
          context: {},
          solutions: [],
        },
      ],
      table: [
        independentSection({ id: "mcp", run: Effect.succeed(finding("mcp")) }),
        independentSection({
          id: "network-trust",
          run: Effect.sync(() => {
            unselectedRuns += 1;
            return finding("excluded");
          }),
        }),
        independentSection({
          id: "deprecations",
          when: (options) => options.deprecations === true,
          run: Effect.succeed(finding("selected-opt-in")),
        }),
      ],
    }),
  );
  expect(report.checks.map((check) => check.section)).toEqual(["global-config", "mcp", "deprecations"]);
  expect(report.skipped).toEqual([]);
  expect(unselectedRuns).toBe(0);
});

test("unknown section ids are usage errors listing valid ids", () => {
  const error = validateCliFlagValues(["--section", "unknown"], metaDoctorSpec.flags ?? {});
  expect(error).toBeInstanceOf(MalformedCliFlagValueError);
  expect(error).toMatchObject({
    flag: "section",
    issue: "invalid_option",
    remediation: expect.stringContaining("mcp"),
  });
  expect(() => inputDoctorOptions({ flags: { section: ["unknown"] } })).toThrow(MalformedCliFlagValueError);
  expect(
    validateCliFlagValues(["--section", "mcp", "--section", "filesystem-watch"], metaDoctorSpec.flags ?? {}),
  ).toBeUndefined();
});

test("default producers redact secrets registered in the supplied context", async () => {
  const secret = "192.0.2.77";
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* Layer.build(configLayer);
      const redaction = yield* Layer.build(RedactionService.layer);
      yield* Context.get(redaction, RedactionService).registerValues([secret]);
      const value = Schema.decodeUnknownSync(GlobalConfig)({ debugger: { host: secret } });
      const context = Context.add(
        Context.merge(config, redaction),
        ConfigService,
        ConfigService.of({
          load: Effect.succeed(value),
          get: (key) => Effect.succeed(value[key]),
        }),
      );
      return yield* collectDoctorReport({
        options: { env: {}, sections: ["debugger-host"], platform: "darwin" },
        contexts: { config: context },
      });
    }).pipe(Effect.scoped),
  );
  expect(report.checks).toMatchObject([
    { name: "debugger-host", context: { configuredHost: "[redacted]", effectiveHost: "[redacted]" } },
  ]);
  expect(JSON.stringify(report)).not.toContain(secret);
});
