import { describe, expect, test } from "bun:test";
import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { ConfigService, PathsService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport";
import { plugin as mutagenPlugin } from "@lando/file-sync-mutagen";
import { makeLandoPaths } from "@lando/paths";
import { plugin as podmanPlugin } from "@lando/provider-podman";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  type GlobalConfig,
  PluginManifest,
  ProviderCapabilities,
  ProviderId,
  StreamFrame,
} from "@lando/sdk/schema";
import { type Context, Effect, Layer, Schema } from "effect";
import { metaDoctorSpec } from "../../src/cli/command-specs/meta/doctor.ts";
import type { DoctorSectionResult } from "../../src/cli/commands/doctor.ts";
import { type DoctorOptions, doctor } from "../../src/cli/commands/doctor.ts";
import { type DoctorCheck, DoctorNdjsonResultSchema } from "../../src/cli/commands/doctor-contract.ts";
import { renderDoctorReportAsNdjson } from "../../src/cli/commands/doctor-render-ndjson.ts";
import { renderDoctorReport } from "../../src/cli/commands/doctor-render-text.ts";
import { makeDoctorReport } from "../../src/cli/commands/doctor-report.ts";

const asReport = (result: DoctorSectionResult) =>
  makeDoctorReport({
    ...(result.provider === undefined ? {} : { provider: result.provider }),
    checks: result.checks.map((check) => ({ section: "provider" as const, ...check })),
    skipped: (result.skipped ?? []).map((skip) => ({ section: "provider" as const, ...skip })),
  });

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "meta-doctor.provider-status.ndjson");
const WINDOWS_FIXTURE_PATH = join(import.meta.dir, "fixtures", "meta-doctor.provider-status.windows.ndjson");
const providerWithComposeServiceFields = {
  ...TestRuntimeProvider,
  id: "lando",
  capabilities: {
    ...TestRuntimeProvider.capabilities,
    composeServiceFields: { supported: ["configs", "secrets", "profiles", "labels"] },
  },
} satisfies typeof TestRuntimeProvider;

const OPTIONAL_CAPABILITY_FIELDS = new Set([
  "fileSyncTargets",
  "authoredNetworks",
  "composePreservedPaths",
  "composeProjectFields",
  "hostProxy",
  "agentSocket",
]);
const doctorPathsLayer = Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", env: {} }));

const decodeFrames = (ndjson: string) =>
  ndjson
    .trimEnd()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));

const eventPayloads = (ndjson: string): ReadonlyArray<Record<string, unknown>> =>
  decodeFrames(ndjson).flatMap((frame) =>
    frame._tag === "event" ? [frame.payload as Record<string, unknown>] : [],
  );

const firstCheckPayload = (ndjson: string): Record<string, unknown> => {
  const first = eventPayloads(ndjson)[0];
  if (first === undefined) throw new Error("expected doctor.check frame");
  return first;
};

const resultEnvelope = (ndjson: string) => {
  const frame = decodeFrames(ndjson).at(-1);
  if (frame?._tag !== "result") throw new Error("expected terminal result frame");
  return frame.envelope;
};

const buildRegistry = (provider: typeof TestRuntimeProvider) =>
  RuntimeProviderRegistry.of({
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
    appliedPlansFor: () => Effect.succeed([]),
    list: Effect.succeed([ProviderId.make(provider.id)]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });

const buildConfigService = (
  overrides: Partial<GlobalConfig> = {},
): Context.Service.Shape<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    ...overrides,
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return ConfigService.of({
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  });
};

const buildLayers = (
  provider: typeof TestRuntimeProvider,
  configOverrides: Partial<GlobalConfig> = {},
): Layer.Layer<ConfigService | PathsService | RuntimeProviderRegistry> =>
  Layer.mergeAll(
    Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
    Layer.succeed(ConfigService, ConfigService.of(buildConfigService(configOverrides))),
    doctorPathsLayer,
  );

const doctorWithoutPluginChecks = (options: DoctorOptions = {}) => doctor(options, []);

describe("meta:doctor command", () => {
  test("threads an explicit WSL platform to plugin doctor checks verbatim", async () => {
    // Given
    let observedPlatform: string | undefined;
    const module: LandoPluginModule = {
      name: "@lando/doctor-platform-test",
      manifest: Schema.decodeSync(PluginManifest)({
        name: "@lando/doctor-platform-test",
        version: "1.0.0",
        api: 4,
      }),
      doctorChecks: [
        {
          id: "platform-threading",
          run: (context) => {
            observedPlatform = context.platform;
            return Effect.succeed([]);
          },
        },
      ],
    };

    // When
    await Effect.runPromise(
      doctor({ platform: "wsl", env: {} }, [module]).pipe(Effect.provide(buildLayers(TestRuntimeProvider))),
    );

    // Then
    expect(observedPlatform).toBe("wsl");
  });

  test("renders the selected provider and every declared ProviderCapabilities field", async () => {
    const provider = providerWithComposeServiceFields;
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const output = renderDoctorReport(asReport(result), undefined, { all: true });

    expect(output).toContain("selected-provider: pass");
    expect(output).toContain("provider: lando");
    for (const field of Object.keys(ProviderCapabilities.fields)) {
      if (OPTIONAL_CAPABILITY_FIELDS.has(field) && !Object.hasOwn(provider.capabilities, field)) continue;
      expect(output).toContain(`${field}:`);
    }
  });

  test("renders providerKind: managed for provider-lando", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks({ platform: "linux", env: {} }).pipe(Effect.provide(buildLayers(provider))),
    );
    const text = renderDoctorReport(asReport(result));

    expect(text).toContain("providerKind: managed");
    expect(result.provider?.kind).toBe("managed");
  });

  test("renders providerKind: user-installed for provider-podman", async () => {
    const provider = { ...TestRuntimeProvider, id: "podman" };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const text = renderDoctorReport(asReport(result));

    expect(text).toContain("providerKind: user-installed");
    expect(result.provider?.kind).toBe("user-installed");
  });

  test("renders providerKind: user-installed for provider-docker", async () => {
    const provider = { ...TestRuntimeProvider, id: "docker" };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const text = renderDoctorReport(asReport(result));
    expect(text).toContain("providerKind: user-installed");
    expect(result.provider?.kind).toBe("user-installed");
  });

  test("renders providerKind: user-installed for unknown providers (safe default)", async () => {
    const provider = { ...TestRuntimeProvider, id: "third-party-thing" };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    expect(result.provider?.kind).toBe("user-installed");
  });

  test("renders array-valued capabilities as JSON, not [object Object]", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, providerExtensions: ["compose", "exec"] },
    };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const output = renderDoctorReport(asReport(result), undefined, { all: true });

    expect(output).toContain('providerExtensions: ["compose","exec"]');
    expect(output).not.toContain("[object Object]");
  });

  test("renders empty array capabilities as []", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const output = renderDoctorReport(asReport(result), undefined, { all: true });

    expect(output).toContain("providerExtensions: []");
    expect(output).not.toContain("[object Object]");
  });

  test("meta:doctor bootstrap level is none so a failed bootstrap cannot block diagnostics", () => {
    // Doctor builds the provider runtime inside its own program (doctor-bootstrap.ts)
    // and reports a build failure as a self check, so it must not declare a level
    // that the CLI would eagerly build before the command body runs.
    expect(metaDoctorSpec.bootstrap).toBe("none");
  });

  test("ndjson output matches the meta-doctor.provider-status.ndjson fixture", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const actual = renderDoctorReportAsNdjson(asReport(result));
    const expected = readFileSync(FIXTURE_PATH, "utf-8");

    expect(`${actual}\n`).toBe(expected);
  });

  test("ndjson stream carries every ProviderCapabilities field, provider identity, runtime info, severity, context, and a solution list", async () => {
    const provider = providerWithComposeServiceFields;
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const ndjson = renderDoctorReportAsNdjson(asReport(result));
    const wire = Schema.decodeUnknownSync(DoctorNdjsonResultSchema)(resultEnvelope(ndjson).result);
    expect(decodeFrames(ndjson).at(-1)?._tag).toBe("result");
    expect(resultEnvelope(ndjson)).toMatchObject({
      command: "meta:doctor",
      ok: true,
      result: {
        summary: { checks: 3, failed: 0, warned: 1 },
      },
    });

    const check = firstCheckPayload(ndjson);
    expect(check.name).toBe("selected-provider");
    expect(check.status).toBe("pass");
    expect(check.severity).toBe("info");
    expect(wire.provider?.id).toBe("lando");
    expect(wire.provider?.name).toBe(provider.displayName);
    expect(wire.provider?.version).toBe(provider.version);

    expect(wire.provider?.runtime).toMatchObject({ running: true, message: "ready", version: "0.0.0-test" });

    const capabilities = wire.provider?.capabilities;
    for (const field of Object.keys(ProviderCapabilities.fields)) {
      if (OPTIONAL_CAPABILITY_FIELDS.has(field) && !Object.hasOwn(provider.capabilities, field)) continue;
      expect(capabilities).toHaveProperty(field);
    }

    const context = check.context as Record<string, string>;
    expect(wire.provider?.runtimeStatus).toBe("ready");
    expect(context.runtimeVersion).toBe("0.0.0-test");
    expect(context.platform).toBe(provider.platform);

    expect(check.solutions).toEqual([]);
  });

  test("idle managed runtime passes and skips live probes without starting it", async () => {
    const liveCalls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      getStatus: Effect.succeed({ state: "idle" as const }),
      ensureReady: Effect.die("doctor must never start an idle runtime"),
      list: (...args: Parameters<typeof TestRuntimeProvider.list>) => {
        liveCalls.push("list");
        return TestRuntimeProvider.list(...args);
      },
      exec: (...args: Parameters<typeof TestRuntimeProvider.exec>) => {
        liveCalls.push("exec");
        return TestRuntimeProvider.exec(...args);
      },
    };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const text = renderDoctorReport(asReport(result), undefined, { all: true });
    const ndjson = renderDoctorReportAsNdjson(asReport(result));
    const check = firstCheckPayload(ndjson);

    expect(text).not.toContain("engineId: mutagen");

    expect(check.status).toBe("pass");
    expect(check.severity).toBe("info");
    const runtime = result.provider?.runtime as Record<string, unknown>;
    expect(runtime.running).toBe(false);
    expect(result.provider?.runtimeStatus).toBe("idle (starts on demand)");
    const solutions = check.solutions as Array<Record<string, unknown>>;
    expect(solutions).toEqual([]);
    expect(result.checks.find((entry) => entry.name === "runtime-service")?.status).toBe("pass");
    expect(result.skipped?.map((entry) => entry.check)).toEqual(
      expect.arrayContaining(["exec-umask", "container-died-events", "runtime-oom"]),
    );

    const complete = resultEnvelope(ndjson).result as {
      readonly summary: { readonly checks: number; readonly warned: number; readonly failed: number };
    };
    expect(complete.summary.warned).toBe(0);
    expect(complete.summary.failed).toBe(0);

    expect(text).toContain("selected-provider: pass");
    expect(liveCalls).toEqual([]);
  });

  test("failed Docker status preserves its own remediation without a self diagnosis", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "docker",
      getStatus: Effect.fail(
        new ProviderUnavailableError({
          providerId: "docker",
          operation: "getStatus",
          message: "docker daemon unavailable",
          remediation: "Start Docker Desktop and retry.",
        }),
      ),
    };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks({ env: {} }).pipe(
        Effect.provide(buildLayers(provider, { defaultProviderId: ProviderId.make("docker") })),
      ),
    );
    const text = renderDoctorReport(asReport(result));
    const ndjson = renderDoctorReportAsNdjson(asReport(result));
    const check = firstCheckPayload(ndjson);

    expect(check.status).toBe("fail");
    expect(check.severity).toBe("error");
    expect(result.provider?.id).toBe("docker");
    expect(result.provider?.selection.source).toBe("config");
    expect(result.provider?.selection.inputs.config).toBe("docker");
    const runtime = result.provider?.runtime as Record<string, unknown>;
    expect(runtime.running).toBe(false);
    const solutions = check.solutions as Array<Record<string, unknown>>;
    expect(solutions).toEqual([{ kind: "manual", description: "Start Docker Desktop and retry." }]);
    expect(result.checks.filter((check) => check.name === "doctor-self")).toEqual([]);
    expect(text).toContain("selected-provider: fail");
  });

  test("consumes the latest setup readiness summary with redacted failure remediation", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-setup-readiness-"));
    try {
      await mkdir(join(dataRoot, "setup"), { recursive: true });
      await writeFile(
        join(dataRoot, "setup", "readiness.json"),
        `${JSON.stringify({
          status: "failed",
          providerId: "podman",
          updatedAt: "1970-01-01T00:00:00.000Z",
          steps: [
            { id: "provider", status: "satisfied", evidence: "Provider lando setup completed." },
            {
              id: "proxy",
              status: "failed",
              evidence: "Router setup failed: HTTP_PROXY_PASSWORD=super-secret",
              remediation: "Rerun `lando setup`; HTTP_PROXY_PASSWORD=super-secret",
            },
          ],
        })}\n`,
        "utf-8",
      );
      const provider = { ...TestRuntimeProvider, id: "lando" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks().pipe(
          Effect.provide(buildLayers(provider, { userDataRoot: AbsolutePath.make(dataRoot) })),
        ),
      );
      const text = renderDoctorReport(asReport(result));
      const ndjson = renderDoctorReportAsNdjson(asReport(result));
      const setupCheck = result.checks.find((check) => check.name === "setup-readiness");

      expect(setupCheck?.status).toBe("warn");
      expect(setupCheck?.context.setupProviderId).toBe("podman");
      expect(setupCheck?.context.lastFailedStep).toBe("proxy");
      expect(setupCheck?.context.stepProvider).toBe("satisfied");
      expect(setupCheck?.context.stepProxy).toBe("failed");
      expect(setupCheck?.solutions[0]?.command).toBe("lando setup --provider=podman");
      expect(text).toContain("setup-readiness: warn");
      expect(text).toContain("setupProviderId: podman");
      expect(text).toContain("lastFailedStep: proxy");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("super-secret");
      expect(ndjson).toContain("[redacted]");
      expect(ndjson).not.toContain("super-secret");

      expect(eventPayloads(ndjson).some((payload) => payload.name === "setup-readiness")).toBe(true);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "uses the section budget for setup-readiness while other probes keep the probe budget",
    async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-section-budget-"));
      const readiness = join(dataRoot, "setup", "readiness.json");
      await mkdir(join(dataRoot, "setup"), { recursive: true });
      expect(Bun.spawnSync(["mkfifo", readiness]).exitCode).toBe(0);
      // Hold the FIFO open so the readiness read blocks instead of reaching EOF.
      const holder = openSync(readiness, constants.O_RDWR);
      try {
        const provider = {
          ...TestRuntimeProvider,
          id: "lando",
          getStatus: Effect.never as typeof TestRuntimeProvider.getStatus,
        };
        const result = await Effect.runPromise(
          doctorWithoutPluginChecks({ env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } }).pipe(
            Effect.provide(buildLayers(provider, { userDataRoot: AbsolutePath.make(dataRoot) })),
          ),
        );
        const selfFinding = (probe: string) =>
          result.checks.find(
            (candidate) => candidate.name === "doctor-self" && candidate.context.probe === probe,
          );

        // setup-readiness is a whole-section probe: it gets the 1000ms section budget,
        // while a narrower sub-probe keeps doctor's one-third probe budget (333ms).
        expect(selfFinding("provider-status")?.context).toMatchObject({
          reason: "timeout",
          budgetMs: "333",
        });
        expect(selfFinding("setup-readiness")?.context).toMatchObject({
          reason: "timeout",
          budgetMs: "1000",
        });
      } finally {
        closeSync(holder);
        await rm(dataRoot, { recursive: true, force: true });
      }
    },
  );

  test("missing runtime version omits runtimeVersion fields without breaking output", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      getVersions: Effect.succeed({ provider: "0.0.0-test" }),
    };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const ndjson = renderDoctorReportAsNdjson(asReport(result));
    const check = firstCheckPayload(ndjson);

    const runtime = result.provider?.runtime as Record<string, unknown>;
    expect(runtime.running).toBe(true);
    expect(runtime).not.toHaveProperty("version");

    const context = check.context as Record<string, string>;
    expect(context).not.toHaveProperty("runtimeVersion");
  });

  test("ndjson output matches the meta-doctor.provider-status.windows.ndjson fixture (Windows path)", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      platform: "win32" as const,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        sharedCrossAppNetwork: false,
        bindMountPerformance: "slow" as const,
        copyMounts: false,
        fileSyncTargets: "prepared-volume" as const,
      },
      getVersions: Effect.succeed({ provider: "0.0.0-test", runtime: "0.0.0-test", bundle: "0.1.0-test" }),
    };
    const result = await Effect.runPromise(
      doctor({ platform: "win32", env: {} }, [mutagenPlugin]).pipe(Effect.provide(buildLayers(provider))),
    );
    const actual = renderDoctorReportAsNdjson(asReport(result));
    const expected = readFileSync(WINDOWS_FIXTURE_PATH, "utf-8");

    expect(`${actual}\n`).toBe(expected);
  });

  test("Windows path surfaces bindMountPerformance slow, sharedCrossAppNetwork false, and bundle version", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      platform: "win32" as const,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        sharedCrossAppNetwork: false,
        bindMountPerformance: "slow" as const,
        copyMounts: false,
      },
      getVersions: Effect.succeed({ provider: "0.0.0-test", runtime: "0.0.0-test", bundle: "0.1.0-test" }),
    };
    const result = await Effect.runPromise(
      doctorWithoutPluginChecks().pipe(Effect.provide(buildLayers(provider))),
    );
    const ndjson = renderDoctorReportAsNdjson(asReport(result));
    const check = firstCheckPayload(ndjson);

    const capabilities = result.provider?.capabilities as Record<string, unknown>;
    expect(capabilities.bindMountPerformance).toBe("slow");
    expect(capabilities.sharedCrossAppNetwork).toBe(false);
    expect(capabilities.bindMounts).toBe(true);

    const context = check.context as Record<string, string>;
    expect(context.bundleVersion).toBe("0.1.0-test");
    expect(context.platform).toBe("win32");
  });

  const liveWindowsEnabled =
    process.platform === "win32" && process.env.LANDO_TEST_WINDOWS_PROVIDER_LANDO === "1";
  const liveTest = liveWindowsEnabled ? test : test.skip;

  liveTest(
    "live: Windows provider-lando doctor surfaces win32 capabilities and socket/machine status",
    async () => {
      const { layer: makeProviderLayer } = await import("@lando/provider-lando");
      const { RuntimeProvider } = await import("@lando/sdk/services");

      const layer = makeProviderLayer({ platform: "win32", sanitizeAppliedPlan: stripHostProxyRunLando });
      const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));
      const registry = buildRegistry(runtimeProvider as typeof TestRuntimeProvider);
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks().pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(RuntimeProviderRegistry, registry),
              Layer.succeed(ConfigService, ConfigService.of(buildConfigService())),
              doctorPathsLayer,
            ),
          ),
        ),
      );

      expect(result.checks.length).toBeGreaterThanOrEqual(1);
      const check = result.checks[0] as DoctorCheck;
      expect(result.provider?.capabilities?.bindMountPerformance).toBe("slow");
      expect(result.provider?.capabilities?.sharedCrossAppNetwork).toBe(false);
      expect(result.provider?.capabilities?.bindMounts).toBe(true);
      expect(check.context.platform).toBe("win32");
    },
  );

  describe("provider selection precedence reporting", () => {
    test("reports selectionSource: default when no inputs override the capability default", async () => {
      const provider = { ...TestRuntimeProvider, id: "lando" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks({ env: {} }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
              Layer.succeed(ConfigService, ConfigService.of(buildConfigService({ defaultProviderId: null }))),
              doctorPathsLayer,
            ),
          ),
        ),
      );
      expect(result.provider?.selection.source).toBe("default");
      expect(result.provider?.selection.providerId).toBe("lando");
      expect(result.provider?.selection.inputs.capabilityDefault).toBe("lando");
    });

    test("reports selectionSource: config and surfaces the config input", async () => {
      const provider = { ...TestRuntimeProvider, id: "lando" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks({ env: {} }).pipe(Effect.provide(buildLayers(provider))),
      );
      expect(result.provider?.selection.source).toBe("config");
      expect(result.provider?.selection.inputs.config).toBe("lando");
    });

    test("reports leftover defaultProviderId: docker as the selected provider", async () => {
      const provider = { ...TestRuntimeProvider, id: "docker" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks({ env: {} }).pipe(
          Effect.provide(buildLayers(provider, { defaultProviderId: ProviderId.make("docker") })),
        ),
      );
      expect(result.provider?.id).toBe("docker");
      expect(result.provider?.selection.providerId).toBe("docker");
      expect(result.provider?.selection.source).toBe("config");
      expect(result.provider?.selection.inputs.config).toBe("docker");
    });

    test("reports selectionSource: env when LANDO_PROVIDER is set", async () => {
      const provider = { ...TestRuntimeProvider, id: "podman" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks({ env: { LANDO_PROVIDER: "podman" } }).pipe(
          Effect.provide(buildLayers(provider)),
        ),
      );
      expect(result.provider?.selection.source).toBe("env");
      expect(result.provider?.selection.inputs.env).toBe("podman");
      expect(result.provider?.selection.inputs.config).toBe("lando");
    });

    test("reports selectionSource: landofile when a Landofile provider is provided", async () => {
      const provider = { ...TestRuntimeProvider, id: "docker" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks({ env: {}, landofileProviderId: "docker" }).pipe(
          Effect.provide(buildLayers(provider)),
        ),
      );
      expect(result.provider?.selection.source).toBe("landofile");
      expect(result.provider?.selection.inputs.landofile).toBe("docker");
    });

    test("reports selectionSource: flag when --provider is passed", async () => {
      const provider = { ...TestRuntimeProvider, id: "podman" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks({
          env: { LANDO_PROVIDER: "docker" },
          flagProviderId: "podman",
          landofileProviderId: "docker",
        }).pipe(Effect.provide(buildLayers(provider))),
      );
      expect(result.provider?.selection.source).toBe("flag");
      expect(result.provider?.selection.inputs.flag).toBe("podman");
      expect(result.provider?.selection.inputs.landofile).toBe("docker");
      expect(result.provider?.selection.inputs.env).toBe("docker");
    });

    test("renderDoctorResult surfaces selection metadata in plain text", async () => {
      const provider = { ...TestRuntimeProvider, id: "lando" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks({
          env: { LANDO_PROVIDER: "podman" },
          flagProviderId: "lando",
        }).pipe(Effect.provide(buildLayers(provider))),
      );
      const text = renderDoctorReport(asReport(result));
      expect(text).toContain("selectionSource: flag");
      expect(text).toContain("selectionInputFlag: lando");
      expect(text).toContain("selectionInputEnv: podman");
      expect(text).toContain("selectionInputConfig: lando");
      expect(text).toContain("selectionInputDefault: lando");
    });

    test("ndjson terminal frame carries the provider selection record", async () => {
      const provider = { ...TestRuntimeProvider, id: "podman" };
      const result = await Effect.runPromise(
        doctorWithoutPluginChecks({ env: { LANDO_PROVIDER: "podman" } }).pipe(
          Effect.provide(buildLayers(provider)),
        ),
      );
      const ndjson = renderDoctorReportAsNdjson(asReport(result));
      const wire = Schema.decodeUnknownSync(DoctorNdjsonResultSchema)(resultEnvelope(ndjson).result);
      expect(wire.provider?.selection).toEqual({
        source: "env",
        providerId: "podman",
        inputs: { env: "podman", config: "lando", capabilityDefault: "lando" },
      });
    });
  });

  describe("provider conflict diagnostics", () => {
    const buildConfigServiceWith = (userDataRoot: string) =>
      buildConfigService({ userDataRoot: AbsolutePath.make(userDataRoot) });

    const writeProviderLandoState = async (stateRoot: string, socketPath: string): Promise<string> => {
      const dir = join(stateRoot, "providers", "provider-lando");
      await mkdir(dir, { recursive: true });
      const statePath = join(dir, "setup-state.json");
      await writeFile(statePath, JSON.stringify({ socketPath }), "utf8");
      return statePath;
    };

    test("emits a provider-conflict check with remediation when lando+podman share a socket", async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-conflict-"));
      try {
        const socket = "/run/user/1000/podman/podman.sock";
        const statePath = await writeProviderLandoState(dataRoot, socket);
        const provider = { ...TestRuntimeProvider, id: "podman" };
        const result = await Effect.runPromise(
          doctor({
            env: { LANDO_PROVIDER: "podman", XDG_RUNTIME_DIR: "/run/user/1000" },
            platform: "linux",
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
                Layer.succeed(ConfigService, ConfigService.of(buildConfigServiceWith(dataRoot))),
                doctorPathsLayer,
              ),
            ),
          ),
        );

        expect(result.checks.length).toBe(1);
        const conflictCheck = result.checks[0] as DoctorCheck;
        expect(conflictCheck.name).toBe("provider-conflict");
        expect(conflictCheck.status).toBe("warn");
        expect(conflictCheck.severity).toBe("warn");
        expect(conflictCheck.context.conflictKind).toBe("provider-lando-podman-socket");
        expect(conflictCheck.context.socketPath).toBe(socket);
        expect(normalize(String(conflictCheck.context.providerLandoStatePath ?? ""))).toBe(
          normalize(statePath),
        );
        const solution = conflictCheck.solutions[0];
        expect(solution?.kind).toBe("manual");
        expect(solution?.description).toContain("lando setup --provider=");
        expect(solution?.description).toContain("provider=podman");
        expect(solution?.description).toContain("provider=lando");
        expect(solution?.command).toBe("lando setup --provider=podman");

        const text = renderDoctorReport(asReport(result));
        expect(text).toContain("provider-conflict: warn");
        expect(text).toContain("lando setup --provider=");

        const ndjson = renderDoctorReportAsNdjson(asReport(result));
        const conflictPayload = eventPayloads(ndjson).find((payload) => payload.name === "provider-conflict");
        if (conflictPayload === undefined) throw new Error("expected provider-conflict frame");
        expect(conflictPayload.name).toBe("provider-conflict");
        const complete = resultEnvelope(ndjson).result as {
          readonly summary: { readonly checks: number; readonly warned: number; readonly failed: number };
        };
        expect(complete.summary.warned).toBe(1);
        expect(complete.summary.failed).toBe(0);
        expect(complete.summary.checks).toBe(1);
      } finally {
        await rm(dataRoot, { recursive: true, force: true });
      }
    });

    test("emits a provider-conflict check before selecting provider-podman", async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-preselect-conflict-"));
      try {
        const socket = "/run/user/1000/podman/podman.sock";
        await writeProviderLandoState(dataRoot, socket);
        const registry = RuntimeProviderRegistry.of({
          resolveAppliedPlan: () => Effect.succeed(undefined),
          resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
          appliedPlansFor: () => Effect.succeed([]),
          list: Effect.succeed([ProviderId.make("podman")]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.die("provider-podman should not be constructed when conflict is pre-detected"),
        });
        const result = await Effect.runPromise(
          doctor({
            env: { LANDO_PROVIDER: "podman", XDG_RUNTIME_DIR: "/run/user/1000" },
            platform: "linux",
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(RuntimeProviderRegistry, registry),
                Layer.succeed(ConfigService, ConfigService.of(buildConfigServiceWith(dataRoot))),
                doctorPathsLayer,
              ),
            ),
          ),
        );

        expect(result.checks).toHaveLength(1);
        const conflictCheck = result.checks[0] as DoctorCheck;
        expect(conflictCheck.name).toBe("provider-conflict");
        expect(result.provider?.id).toBe("podman");
        expect(result.provider?.selection.source).toBe("env");
        expect(result.provider?.selection.providerId).toBe("podman");
        expect(conflictCheck.solutions[0]?.command).toBe("lando setup --provider=podman");
      } finally {
        await rm(dataRoot, { recursive: true, force: true });
      }
    });

    test("emits no provider-conflict check when there is no socket overlap", async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-nooverlap-"));
      try {
        await writeProviderLandoState(dataRoot, "/var/run/lando/podman.sock");
        const provider = { ...TestRuntimeProvider, id: "lando" };
        const result = await Effect.runPromise(
          doctor(
            {
              env: { LANDO_PROVIDER: "podman", XDG_RUNTIME_DIR: "/run/user/1000" },
              platform: "linux",
            },
            [podmanPlugin],
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
                Layer.succeed(ConfigService, ConfigService.of(buildConfigServiceWith(dataRoot))),
                doctorPathsLayer,
              ),
            ),
          ),
        );
        expect(result.checks.map((check) => check.name)).toEqual([
          "selected-provider",
          "runtime-service",
          "exec-umask",
        ]);
      } finally {
        await rm(dataRoot, { recursive: true, force: true });
      }
    });
  });
});
