import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
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

describe("meta:doctor command", () => {
  test("renders the selected provider and every ProviderCapabilities field", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
    const output = renderDoctorResult(result);

    expect(output).toContain("selected-provider: pass");
    expect(output).toContain("provider: lando");
    for (const field of Object.keys(ProviderCapabilities.fields)) {
      expect(output).toContain(`${field}:`);
    }
  });

  test("renders providerKind: managed for provider-lando", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
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
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
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
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
    const text = renderDoctorResult(result);
    expect(text).toContain("providerKind: user-installed");
    expect(result.checks[0]?.providerKind).toBe("user-installed");
  });

  test("renders providerKind: user-installed for unknown providers (safe default)", async () => {
    const provider = { ...TestRuntimeProvider, id: "third-party-thing" };
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
    expect(result.checks[0]?.providerKind).toBe("user-installed");
  });

  test("renders array-valued capabilities as JSON, not [object Object]", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, providerExtensions: ["compose", "exec"] },
    };
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
    const output = renderDoctorResult(result);

    expect(output).toContain('providerExtensions: ["compose","exec"]');
    expect(output).not.toContain("[object Object]");
  });

  test("renders empty array capabilities as []", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
    const output = renderDoctorResult(result);

    expect(output).toContain("providerExtensions: []");
    expect(output).not.toContain("[object Object]");
  });

  test("meta:doctor bootstrap level is provider, never app", () => {
    expect(metaDoctorSpec.bootstrap).toBe("provider");
  });

  test("ndjson output matches the meta-doctor.provider-status.ndjson fixture", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
    const actual = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const expected = readFileSync(FIXTURE_PATH, "utf-8");

    expect(actual).toBe(expected);
  });

  test("ndjson stream carries every ProviderCapabilities field, provider identity, runtime info, severity, context, and a solution list", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
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
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date("1970-01-01T00:00:00.000Z") });
    const lines = ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const check = lines[1] as Record<string, unknown>;

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

    const text = renderDoctorResult(result);
    expect(text).toContain("selected-provider: warn");
    expect(text).toContain("severity: warn");
    expect(text).toContain("solution[manual]:");
    expect(text).toContain("lando setup");
  });

  test("missing runtime version omits runtimeVersion fields without breaking output", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      getVersions: Effect.succeed({ provider: "0.0.0-test" }),
    };
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
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
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
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
    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)))),
    );
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
        doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, registry))),
      );

      expect(result.checks.length).toBeGreaterThanOrEqual(1);
      const check = result.checks[0] as DoctorCheck;
      expect(check.capabilities.bindMountPerformance).toBe("slow");
      expect(check.capabilities.sharedCrossAppNetwork).toBe(false);
      expect(check.capabilities.bindMounts).toBe(true);
      expect(check.context.platform).toBe("win32");
    },
  );
});
