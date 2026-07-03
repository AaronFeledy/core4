import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { ProxyError } from "@lando/sdk/errors";
import {
  CertificateAuthority,
  HealthcheckRunner,
  ProxyService,
  SshService,
  UrlScanner,
} from "@lando/sdk/services";

import {
  DefaultSubsystemDoctorLayer,
  type SubsystemDoctorResult,
  classifySubsystemFailure,
  renderSubsystemDoctorResult,
  renderSubsystemDoctorResultAsNdjson,
  subsystemDoctor,
  subsystemFailureDiagnostic,
} from "../../src/cli/commands/doctor-subsystems.ts";
import { inputDoctorOptions } from "../../src/cli/oclif/commands/meta/doctor.ts";
import { CertificateAuthorityUnavailableLive } from "../../src/subsystems/certs/api.ts";
import { HealthcheckRunnerUnavailableLive } from "../../src/subsystems/healthcheck/api.ts";
import { ProxyServiceUnavailableLive } from "../../src/subsystems/proxy/api.ts";
import { UrlScannerUnavailableLive } from "../../src/subsystems/scanner/api.ts";
import { SshServiceUnavailableLive } from "../../src/subsystems/ssh/api.ts";

const AUTOMATIC_SUBSYSTEMS = ["proxy", "ssh"] as const;
const MANUAL_SUBSYSTEMS = ["certs", "healthcheck", "scanner", "host-proxy"] as const;
const DEGRADED_MANUAL_SUBSYSTEMS = ["certs", "host-proxy"] as const;
const READY_MANUAL_SUBSYSTEMS = ["healthcheck", "scanner"] as const;

const runDefault = (fix: boolean): Promise<SubsystemDoctorResult> =>
  Effect.runPromise(subsystemDoctor({ fix }).pipe(Effect.provide(DefaultSubsystemDoctorLayer)));

const expectTaggedDiagnosticForFailure = (
  subsystem: string,
  exit: { readonly _tag: string; readonly cause?: unknown },
): void => {
  expect(exit._tag).toBe("Failure");
  const diagnostic = subsystemFailureDiagnostic(subsystem, exit.cause);
  expect(diagnostic._tag).toBe("DoctorSubsystemFailure");
  expect(diagnostic.subsystem).toBe(subsystem);
  expect(["info", "warn", "error"]).toContain(diagnostic.severity);
  expect(diagnostic.solution.description.length).toBeGreaterThan(0);
};

describe("subsystem failure-recovery classification", () => {
  test("classifies proxy/ssh as automatic and certs/host-proxy/healthcheck/scanner as manual", async () => {
    const result = await runDefault(false);
    const byName = new Map(result.checks.map((check) => [check.name, check] as const));

    for (const name of AUTOMATIC_SUBSYSTEMS) {
      expect(byName.get(name)?.recovery).toBe("automatic");
    }
    for (const name of MANUAL_SUBSYSTEMS) {
      expect(byName.get(name)?.recovery).toBe("manual");
    }
  });

  test("read-only mode advertises an automatic `lando doctor --fix` solution for proxy and ssh", async () => {
    const result = await runDefault(false);
    for (const name of AUTOMATIC_SUBSYSTEMS) {
      const check = result.checks.find((c) => c.name === name);
      expect(check?.status).toBe("warn");
      const solution = check?.solutions[0];
      expect(solution?.kind).toBe("automatic");
      expect(solution?.command).toBe("lando doctor --fix");
    }
  });

  test("read-only mode keeps a manual `lando setup` solution for degraded stub-backed subsystems", async () => {
    const result = await runDefault(false);
    for (const name of DEGRADED_MANUAL_SUBSYSTEMS) {
      const check = result.checks.find((c) => c.name === name);
      expect(check?.status).toBe("warn");
      const solution = check?.solutions[0];
      expect(solution?.kind).toBe("manual");
      expect(solution?.command).toBe("lando setup");
    }
  });

  test("healthcheck and scanner report ready via their real runProbe-backed runners", async () => {
    const result = await runDefault(false);
    for (const name of READY_MANUAL_SUBSYSTEMS) {
      const check = result.checks.find((c) => c.name === name);
      expect(check?.status).toBe("pass");
      expect(check?.context.ready).toBe("true");
      expect(check?.solutions).toEqual([]);
    }
  });

  test("read-only mode never attempts a fix (no fixOutcome context)", async () => {
    const result = await runDefault(false);
    for (const check of result.checks) {
      expect(check.context.fixOutcome).toBeUndefined();
    }
  });
});

describe("each subsystem failure path produces a tagged error with severity + solution", () => {
  test("classifySubsystemFailure returns severity + solution for every subsystem", () => {
    for (const name of [...AUTOMATIC_SUBSYSTEMS, ...MANUAL_SUBSYSTEMS]) {
      const classified = classifySubsystemFailure(name);
      expect(classified).toBeDefined();
      if (classified === undefined) throw new Error(`missing classification for ${name}`);
      expect(["info", "warn", "error"]).toContain(classified.severity);
      expect(classified?.solution.description.length).toBeGreaterThan(0);
    }
    expect(classifySubsystemFailure("nope")).toBeUndefined();
  });

  test("each bundled subsystem failure path fails with its tagged error and maps to a diagnostic", async () => {
    const proxy = await Effect.runPromiseExit(
      Effect.flatMap(ProxyService, (s) => s.setup()).pipe(Effect.provide(ProxyServiceUnavailableLive)),
    );
    expectTaggedDiagnosticForFailure("proxy", proxy);

    const ca = await Effect.runPromiseExit(
      Effect.flatMap(CertificateAuthority, (s) => s.setup({ force: false })).pipe(
        Effect.provide(CertificateAuthorityUnavailableLive),
      ),
    );
    expectTaggedDiagnosticForFailure("certs", ca);

    const ssh = await Effect.runPromiseExit(
      Effect.flatMap(SshService, (s) => s.setup({ force: false })).pipe(
        Effect.provide(SshServiceUnavailableLive),
      ),
    );
    expectTaggedDiagnosticForFailure("ssh", ssh);

    const hc = await Effect.runPromiseExit(
      Effect.flatMap(HealthcheckRunner, (s) =>
        s.run({ probes: [] } as never, "app" as never, "web" as never),
      ).pipe(Effect.provide(HealthcheckRunnerUnavailableLive)),
    );
    expectTaggedDiagnosticForFailure("healthcheck", hc);

    const scanner = await Effect.runPromiseExit(
      Effect.flatMap(UrlScanner, (s) => s.scan("app" as never)).pipe(
        Effect.provide(UrlScannerUnavailableLive),
      ),
    );
    expectTaggedDiagnosticForFailure("scanner", scanner);

    const diag = subsystemFailureDiagnostic("proxy", new Error("boom"));
    expect(diag._tag).toBe("DoctorSubsystemFailure");
    expect(diag.subsystem).toBe("proxy");
    expect(["info", "warn", "error"]).toContain(diag.severity);
    expect(diag.solution.description.length).toBeGreaterThan(0);
  });
});

describe("doctor --fix recovery", () => {
  test("--fix attempts setup for degraded automatic subsystems and reports a failed outcome against the bundled stubs", async () => {
    const result = await runDefault(true);
    for (const name of AUTOMATIC_SUBSYSTEMS) {
      const check = result.checks.find((c) => c.name === name);
      expect(check?.context.fixOutcome).toBe("failed");
      expect(check?.context.fixExitCode).toBe("1");
      expect(check?.context.fixError?.length).toBeGreaterThan(0);
      const solution = check?.solutions[0];
      expect(solution?.kind).toBe("manual");
      expect(solution?.command).toBe("lando setup");
    }
  });

  test("--fix records skipped-manual for degraded stub-backed subsystems and never runs them", async () => {
    const result = await runDefault(true);
    for (const name of DEGRADED_MANUAL_SUBSYSTEMS) {
      const check = result.checks.find((c) => c.name === name);
      expect(check?.context.fixOutcome).toBe("skipped-manual");
      expect(check?.context.fixExitCode).toBeUndefined();
      expect(check?.solutions[0]?.kind).toBe("manual");
    }
  });

  test("--fix leaves ready healthcheck/scanner untouched with no fix outcome", async () => {
    const result = await runDefault(true);
    for (const name of READY_MANUAL_SUBSYSTEMS) {
      const check = result.checks.find((c) => c.name === name);
      expect(check?.status).toBe("pass");
      expect(check?.context.fixOutcome).toBeUndefined();
    }
  });

  test("--fix recovers a degraded automatic subsystem when its setup() succeeds", async () => {
    const recoverableProxy = Layer.succeed(ProxyService, {
      id: "unavailable",
      setup: () => Effect.void,
      applyRoutes: () => Effect.void,
      removeRoutes: () => Effect.void,
    });
    const layer = Layer.mergeAll(DefaultSubsystemDoctorLayer, recoverableProxy);
    const result = await Effect.runPromise(subsystemDoctor({ fix: true }).pipe(Effect.provide(layer)));
    const proxy = result.checks.find((c) => c.name === "proxy");

    expect(proxy?.status).toBe("pass");
    expect(proxy?.severity).toBe("info");
    expect(proxy?.context.ready).toBe("true");
    expect(proxy?.context.fixOutcome).toBe("recovered");
    expect(proxy?.context.fixExitCode).toBe("0");
    expect(proxy?.solutions).toEqual([]);
  });

  test("--fix redacts secret-like environment values from failed setup errors", async () => {
    const secretErrorProxy = Layer.succeed(ProxyService, {
      id: "unavailable",
      setup: () =>
        Effect.fail(
          new ProxyError({
            proxyId: "unavailable",
            message: "setup failed API_TOKEN=abc123 DATABASE_PASSWORD=hunter2",
          }),
        ),
      applyRoutes: () => Effect.void,
      removeRoutes: () => Effect.void,
    });
    const layer = Layer.mergeAll(DefaultSubsystemDoctorLayer, secretErrorProxy);
    const result = await Effect.runPromise(subsystemDoctor({ fix: true }).pipe(Effect.provide(layer)));
    const proxy = result.checks.find((c) => c.name === "proxy");
    const text = renderSubsystemDoctorResult(result);
    const ndjson = renderSubsystemDoctorResultAsNdjson(result, {
      now: new Date("1970-01-01T00:00:00.000Z"),
    });

    expect(proxy?.context.fixError).toContain("API_TOKEN=[redacted]");
    expect(proxy?.context.fixError).toContain("DATABASE_PASSWORD=[redacted]");
    expect(text).toContain("API_TOKEN=[redacted]");
    expect(text).not.toContain("abc123");
    expect(ndjson).toContain("DATABASE_PASSWORD=[redacted]");
    expect(ndjson).not.toContain("hunter2");
  });

  test("human renderer surfaces the fix outcome for degraded subsystems under --fix", async () => {
    const result = await runDefault(true);
    const text = renderSubsystemDoctorResult(result);
    expect(text).toContain("fixOutcome: failed");
    expect(text).toContain("fixOutcome: skipped-manual");
  });

  test("OCLIF flag mapping forwards --fix into doctor options for dual-dispatch parity", () => {
    expect(inputDoctorOptions({ flags: { fix: true } })).toEqual({ fix: true });
    expect(inputDoctorOptions({ flags: { provider: "docker", fix: true } })).toEqual({
      flagProviderId: "docker",
      fix: true,
    });
    expect(inputDoctorOptions({ flags: { fix: false } })).toEqual({});
    expect(inputDoctorOptions({ flags: {} })).toEqual({});
  });
});
