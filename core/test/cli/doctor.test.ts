import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Effect, Layer } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { type GlobalConfig, ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import {
  type DoctorCheck,
  doctor,
  renderDoctorResult,
  renderDoctorResultAsNdjson,
} from "../../src/cli/commands/doctor.ts";
import { metaDoctorSpec } from "../../src/cli/oclif/commands/meta/doctor.ts";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "meta-doctor.provider-status.ndjson");
const WINDOWS_FIXTURE_PATH = join(import.meta.dir, "fixtures", "meta-doctor.provider-status.windows.ndjson");

const buildRegistry = (provider: typeof TestRuntimeProvider) => ({
  list: Effect.succeed([ProviderId.make(provider.id)]),
  capabilities: Effect.succeed(provider.capabilities),
  select: () => Effect.succeed(provider),
});

const buildConfigService = (
  overrides: Partial<GlobalConfig> = {},
): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    ...overrides,
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const buildLayers = (
  provider: typeof TestRuntimeProvider,
  configOverrides: Partial<GlobalConfig> = {},
): Layer.Layer<ConfigService | RuntimeProviderRegistry> =>
  Layer.merge(
    Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
    Layer.succeed(ConfigService, buildConfigService(configOverrides)),
  );

describe("meta:doctor command", () => {
  test("renders the selected provider and every ProviderCapabilities field", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const output = renderDoctorResult(result);

    expect(output).toContain("selected-provider: pass");
    expect(output).toContain("provider: lando");
    for (const field of Object.keys(ProviderCapabilities.fields)) {
      expect(output).toContain(`${field}:`);
    }
  });

  test("renders providerKind: managed for provider-lando", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const check = JSON.parse(ndjson.trimEnd().split("\n")[1] ?? "{}") as Record<string, unknown>;

    expect(text).toContain("providerKind: managed");
    expect(check.providerKind).toBe("managed");
    expect((check.context as Record<string, string>).providerKind).toBe("managed");
    expect(result.checks[0]?.providerKind).toBe("managed");
  });

  test("renders providerKind: user-installed for provider-podman", async () => {
    const provider = { ...TestRuntimeProvider, id: "podman" };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const check = JSON.parse(ndjson.trimEnd().split("\n")[1] ?? "{}") as Record<string, unknown>;

    expect(text).toContain("providerKind: user-installed");
    expect(check.providerKind).toBe("user-installed");
    expect((check.context as Record<string, string>).providerKind).toBe("user-installed");
    expect(result.checks[0]?.providerKind).toBe("user-installed");
  });

  test("renders providerKind: user-installed for provider-docker", async () => {
    const provider = { ...TestRuntimeProvider, id: "docker" };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const text = renderDoctorResult(result);
    expect(text).toContain("providerKind: user-installed");
    expect(result.checks[0]?.providerKind).toBe("user-installed");
  });

  test("renders providerKind: user-installed for unknown providers (safe default)", async () => {
    const provider = { ...TestRuntimeProvider, id: "third-party-thing" };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    expect(result.checks[0]?.providerKind).toBe("user-installed");
  });

  test("renders array-valued capabilities as JSON, not [object Object]", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, providerExtensions: ["compose", "exec"] },
    };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const output = renderDoctorResult(result);

    expect(output).toContain('providerExtensions: ["compose","exec"]');
    expect(output).not.toContain("[object Object]");
  });

  test("renders empty array capabilities as []", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const output = renderDoctorResult(result);

    expect(output).toContain("providerExtensions: []");
    expect(output).not.toContain("[object Object]");
  });

  test("meta:doctor bootstrap level is provider, never app", () => {
    expect(metaDoctorSpec.bootstrap).toBe("provider");
  });

  test("ndjson output matches the meta-doctor.provider-status.ndjson fixture", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const actual = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const expected = readFileSync(FIXTURE_PATH, "utf-8");

    expect(actual).toBe(expected);
  });

  test("ndjson stream carries every ProviderCapabilities field, provider identity, runtime info, severity, context, and a solution list", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const lines = ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines[0]).toEqual({ _tag: "doctor.start", timestamp: "1970-01-01T00:00:00.000Z" });
    expect(lines.at(-1)).toEqual({
      _tag: "doctor.complete",
      timestamp: "1970-01-01T00:00:00.000Z",
      checks: 1,
      failed: 0,
      warned: 0,
    });

    const check = lines[1] as Record<string, unknown>;
    expect(check._tag).toBe("doctor.check");
    expect(check.name).toBe("selected-provider");
    expect(check.status).toBe("pass");
    expect(check.severity).toBe("info");
    expect(check.providerId).toBe("lando");
    expect(check.providerName).toBe(provider.displayName);
    expect(check.providerVersion).toBe(provider.version);

    const runtime = check.runtime as Record<string, unknown>;
    expect(runtime.running).toBe(true);
    expect(runtime.message).toBe("ready");
    expect(runtime.version).toBe("0.0.0-test");

    const capabilities = check.capabilities as Record<string, unknown>;
    for (const field of Object.keys(ProviderCapabilities.fields)) {
      expect(capabilities).toHaveProperty(field);
    }

    const context = check.context as Record<string, string>;
    expect(context.providerId).toBe("lando");
    expect(context.providerVersion).toBe(provider.version);
    expect(context.runtimeStatus).toBe("ready");
    expect(context.runtimeVersion).toBe("0.0.0-test");
    expect(context.platform).toBe(provider.platform);

    expect(check.solutions).toEqual([]);
  });

  test("non-running provider produces a warn check with a manual lando setup solution", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      getStatus: Effect.succeed({ running: false, message: "podman socket unavailable" }),
    };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const lines = ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const check = lines[1] as Record<string, unknown>;

    expect(text).not.toContain("engineId: mutagen");

    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warn");
    const runtime = check.runtime as Record<string, unknown>;
    expect(runtime.running).toBe(false);
    expect(runtime.message).toBe("podman socket unavailable");
    const solutions = check.solutions as Array<Record<string, unknown>>;
    expect(solutions.length).toBeGreaterThanOrEqual(1);
    const setupSolution = solutions.find((solution) => solution.command === "lando setup");
    expect(setupSolution).toBeDefined();
    expect(setupSolution?.kind).toBe("manual");
    expect(setupSolution?.description).toContain("lando setup");

    const complete = lines.at(-1) as Record<string, unknown>;
    expect(complete.warned).toBe(1);
    expect(complete.failed).toBe(0);

    expect(text).toContain("selected-provider: warn");
    expect(text).toContain("severity: warn");
    expect(text).toContain("solution[manual]:");
    expect(text).toContain("lando setup");
  });

  test("consumes the latest setup readiness summary with redacted failure remediation", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-setup-readiness-"));
    try {
      await mkdir(join(dataRoot, "setup"), { recursive: true });
      await writeFile(
        join(dataRoot, "setup", "readiness.json"),
        `${JSON.stringify({
          status: "failed",
          providerId: "lando",
          updatedAt: "1970-01-01T00:00:00.000Z",
          steps: [
            { id: "provider", status: "satisfied", evidence: "Provider lando setup completed." },
            {
              id: "proxy",
              status: "failed",
              evidence: "Proxy setup failed: HTTP_PROXY_PASSWORD=super-secret",
              remediation: "Rerun `lando setup`; HTTP_PROXY_PASSWORD=super-secret",
            },
          ],
        })}\n`,
        "utf-8",
      );
      const provider = { ...TestRuntimeProvider, id: "lando" };
      const result = await Effect.runPromise(
        doctor().pipe(Effect.provide(buildLayers(provider, { userDataRoot: dataRoot }))),
      );
      const text = renderDoctorResult(result);
      const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
      const setupCheck = result.checks.find((check) => check.name === "setup-readiness");

      expect(setupCheck?.status).toBe("warn");
      expect(setupCheck?.context.lastFailedStep).toBe("proxy");
      expect(setupCheck?.context.stepProvider).toBe("satisfied");
      expect(setupCheck?.context.stepProxy).toBe("failed");
      expect(setupCheck?.solutions[0]?.command).toBe("lando setup");
      expect(text).toContain("setup-readiness: warn");
      expect(text).toContain("lastFailedStep: proxy");
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain("super-secret");
      expect(ndjson).toContain("[REDACTED]");
      expect(ndjson).not.toContain("super-secret");

      const payloads = ndjson
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(payloads.some((payload) => payload.name === "setup-readiness")).toBe(true);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("missing runtime version omits runtimeVersion fields without breaking output", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      getVersions: Effect.succeed({ provider: "0.0.0-test" }),
    };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const lines = ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const check = lines[1] as Record<string, unknown>;

    const runtime = check.runtime as Record<string, unknown>;
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
      },
      getVersions: Effect.succeed({ provider: "0.0.0-test", runtime: "0.0.0-test", bundle: "0.1.0-test" }),
    };
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const actual = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const expected = readFileSync(WINDOWS_FIXTURE_PATH, "utf-8");

    expect(actual).toBe(expected);
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
    const result = await Effect.runPromise(doctor().pipe(Effect.provide(buildLayers(provider))));
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const lines = ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const check = lines[1] as Record<string, unknown>;

    const capabilities = check.capabilities as Record<string, unknown>;
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
      const { makeProviderLayer } = await import("@lando/provider-lando");
      const { RuntimeProvider } = await import("@lando/sdk/services");

      const layer = makeProviderLayer({ platform: "win32" });
      const runtimeProvider = await Effect.runPromise(RuntimeProvider.pipe(Effect.provide(layer)));
      const registry = buildRegistry(runtimeProvider as typeof TestRuntimeProvider);
      const result = await Effect.runPromise(
        doctor().pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(RuntimeProviderRegistry, registry),
              Layer.succeed(ConfigService, buildConfigService()),
            ),
          ),
        ),
      );

      expect(result.checks.length).toBeGreaterThanOrEqual(1);
      const check = result.checks[0] as DoctorCheck;
      expect(check.capabilities.bindMountPerformance).toBe("slow");
      expect(check.capabilities.sharedCrossAppNetwork).toBe(false);
      expect(check.capabilities.bindMounts).toBe(true);
      expect(check.context.platform).toBe("win32");
    },
  );

  describe("provider selection precedence reporting", () => {
    test("reports selectionSource: default when no inputs override the capability default", async () => {
      const provider = { ...TestRuntimeProvider, id: "lando" };
      const result = await Effect.runPromise(
        doctor({ env: {} }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
              Layer.succeed(ConfigService, buildConfigService({ defaultProviderId: null })),
            ),
          ),
        ),
      );
      const check = result.checks[0] as DoctorCheck;
      expect(check.selection?.source).toBe("default");
      expect(check.selection?.providerId).toBe("lando");
      expect(check.selection?.inputs.capabilityDefault).toBe("lando");
      expect(check.context.selectionSource).toBe("default");
    });

    test("reports selectionSource: config and surfaces the config input", async () => {
      const provider = { ...TestRuntimeProvider, id: "lando" };
      const result = await Effect.runPromise(doctor({ env: {} }).pipe(Effect.provide(buildLayers(provider))));
      const check = result.checks[0] as DoctorCheck;
      expect(check.selection?.source).toBe("config");
      expect(check.selection?.inputs.config).toBe("lando");
      expect(check.context.selectionSource).toBe("config");
    });

    test("reports selectionSource: env when LANDO_PROVIDER is set", async () => {
      const provider = { ...TestRuntimeProvider, id: "podman" };
      const result = await Effect.runPromise(
        doctor({ env: { LANDO_PROVIDER: "podman" } }).pipe(Effect.provide(buildLayers(provider))),
      );
      const check = result.checks[0] as DoctorCheck;
      expect(check.selection?.source).toBe("env");
      expect(check.selection?.inputs.env).toBe("podman");
      expect(check.selection?.inputs.config).toBe("lando");
    });

    test("reports selectionSource: landofile when a Landofile provider is provided", async () => {
      const provider = { ...TestRuntimeProvider, id: "docker" };
      const result = await Effect.runPromise(
        doctor({ env: {}, landofileProviderId: "docker" }).pipe(Effect.provide(buildLayers(provider))),
      );
      const check = result.checks[0] as DoctorCheck;
      expect(check.selection?.source).toBe("landofile");
      expect(check.selection?.inputs.landofile).toBe("docker");
    });

    test("reports selectionSource: flag when --provider is passed", async () => {
      const provider = { ...TestRuntimeProvider, id: "podman" };
      const result = await Effect.runPromise(
        doctor({
          env: { LANDO_PROVIDER: "docker" },
          flagProviderId: "podman",
          landofileProviderId: "docker",
        }).pipe(Effect.provide(buildLayers(provider))),
      );
      const check = result.checks[0] as DoctorCheck;
      expect(check.selection?.source).toBe("flag");
      expect(check.selection?.inputs.flag).toBe("podman");
      expect(check.selection?.inputs.landofile).toBe("docker");
      expect(check.selection?.inputs.env).toBe("docker");
    });

    test("renderDoctorResult surfaces selection metadata in plain text", async () => {
      const provider = { ...TestRuntimeProvider, id: "lando" };
      const result = await Effect.runPromise(
        doctor({
          env: { LANDO_PROVIDER: "podman" },
          flagProviderId: "lando",
        }).pipe(Effect.provide(buildLayers(provider))),
      );
      const text = renderDoctorResult(result);
      expect(text).toContain("selectionSource: flag");
      expect(text).toContain("selectionInputFlag: lando");
      expect(text).toContain("selectionInputEnv: podman");
      expect(text).toContain("selectionInputConfig: lando");
      expect(text).toContain("selectionInputDefault: lando");
    });

    test("ndjson stream carries the selection record on the selected-provider check", async () => {
      const provider = { ...TestRuntimeProvider, id: "podman" };
      const result = await Effect.runPromise(
        doctor({ env: { LANDO_PROVIDER: "podman" } }).pipe(Effect.provide(buildLayers(provider))),
      );
      const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
      const check = JSON.parse(ndjson.trimEnd().split("\n")[1] ?? "{}") as Record<string, unknown>;
      const selection = check.selection as Record<string, unknown>;
      expect(selection).toBeDefined();
      expect(selection.source).toBe("env");
      expect(selection.providerId).toBe("podman");
      const inputs = selection.inputs as Record<string, string>;
      expect(inputs.env).toBe("podman");
      expect(inputs.config).toBe("lando");
      expect(inputs.capabilityDefault).toBe("lando");
    });
  });

  describe("provider conflict diagnostics", () => {
    const buildConfigServiceWith = (userDataRoot: string) => buildConfigService({ userDataRoot });

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
            env: { XDG_RUNTIME_DIR: "/run/user/1000" },
            platform: "linux",
          }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
                Layer.succeed(ConfigService, buildConfigServiceWith(dataRoot)),
              ),
            ),
          ),
        );

        expect(result.checks.length).toBe(2);
        const conflictCheck = result.checks[1] as DoctorCheck;
        expect(conflictCheck.name).toBe("provider-conflict");
        expect(conflictCheck.status).toBe("warn");
        expect(conflictCheck.severity).toBe("warn");
        expect(conflictCheck.context.conflictKind).toBe("provider-lando-podman-socket");
        expect(conflictCheck.context.socketPath).toBe(socket);
        expect(conflictCheck.context.providerLandoStatePath).toBe(statePath);
        const solution = conflictCheck.solutions[0];
        expect(solution?.kind).toBe("manual");
        expect(solution?.description).toContain("lando setup --provider=");
        expect(solution?.description).toContain("provider=podman");
        expect(solution?.description).toContain("provider=lando");
        expect(solution?.command).toBe("lando setup --provider=podman");

        const text = renderDoctorResult(result);
        expect(text).toContain("provider-conflict: warn");
        expect(text).toContain("lando setup --provider=");

        const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
        const lines = ndjson.trimEnd().split("\n");
        const conflictPayload = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;
        expect(conflictPayload.name).toBe("provider-conflict");
        const complete = JSON.parse(lines[3] ?? "{}") as Record<string, unknown>;
        expect(complete.warned).toBe(1);
        expect(complete.failed).toBe(0);
        expect(complete.checks).toBe(2);
      } finally {
        await rm(dataRoot, { recursive: true, force: true });
      }
    });

    test("emits a provider-conflict check before selecting provider-podman", async () => {
      const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-preselect-conflict-"));
      try {
        const socket = "/run/user/1000/podman/podman.sock";
        await writeProviderLandoState(dataRoot, socket);
        const registry = {
          list: Effect.succeed([ProviderId.make("podman")]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.die("provider-podman should not be constructed when conflict is pre-detected"),
        };
        const result = await Effect.runPromise(
          doctor({
            env: { LANDO_PROVIDER: "podman", XDG_RUNTIME_DIR: "/run/user/1000" },
            platform: "linux",
          }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(RuntimeProviderRegistry, registry),
                Layer.succeed(ConfigService, buildConfigServiceWith(dataRoot)),
              ),
            ),
          ),
        );

        expect(result.checks).toHaveLength(1);
        const conflictCheck = result.checks[0] as DoctorCheck;
        expect(conflictCheck.name).toBe("provider-conflict");
        expect(conflictCheck.providerId).toBe("podman");
        expect(conflictCheck.selection?.source).toBe("env");
        expect(conflictCheck.selection?.providerId).toBe("podman");
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
          doctor({
            env: { XDG_RUNTIME_DIR: "/run/user/1000" },
            platform: "linux",
          }).pipe(
            Effect.provide(
              Layer.merge(
                Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
                Layer.succeed(ConfigService, buildConfigServiceWith(dataRoot)),
              ),
            ),
          ),
        );
        expect(result.checks.length).toBe(1);
        expect(result.checks[0]?.name).toBe("selected-provider");
      } finally {
        await rm(dataRoot, { recursive: true, force: true });
      }
    });
  });
});
