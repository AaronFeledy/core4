import { expect, test } from "bun:test";
import type { DebuggerHostDiscovery } from "@lando/engine/subsystems/debugger-host";
import { ProcessExecError } from "@lando/sdk/errors";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Clock, Effect, Schema } from "effect";
import { debuggerHostDoctor } from "../../src/cli/commands/doctor-debugger";
import { DoctorReportSchema, collectDoctorReport } from "../../src/cli/commands/doctor-report";
import { countDoctorChecks } from "../../src/cli/commands/doctor-report-render";

const config = (host?: string) => {
  const value = Schema.decodeUnknownSync(GlobalConfig)(host === undefined ? {} : { debugger: { host } });
  return ConfigService.of({ load: Effect.succeed(value), get: (key) => Effect.succeed(value[key]) });
};
const discovery = (mode = "nat", release = "6.6-microsoft-standard-WSL2"): DebuggerHostDiscovery => ({
  platform: "wsl",
  readFile: async (path) =>
    path.endsWith("osrelease") ? release : "eth0\t00000000\t01301BAC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  runner: {
    run: (options) => {
      expect(options).toEqual({
        cmd: "wslinfo",
        args: ["--networking-mode"],
        timeoutMs: 2000,
        capture: true,
      });
      return Effect.succeed({ exitCode: 0, stdout: mode, stderr: "" });
    },
  },
});
const run = (host?: string, input = discovery()) =>
  Effect.runPromise(
    debuggerHostDoctor((text) => text, 1000, undefined, input).pipe(
      Effect.provideService(ConfigService, config(host)),
    ),
  );

test("non-WSL default is skipped without discovery", async () => {
  const result = await run(undefined, {
    platform: "linux",
    runner: { run: () => Effect.die("unexpected process") },
    readFile: async () => {
      throw new TypeError("unexpected file read");
    },
  });
  expect(result.checks).toEqual([]);
  expect(result.skipped).toMatchObject([{ section: "debugger-host", status: "skipped" }]);
});

test("WSL default remains the host gateway while Windows discovery is only an observation", async () => {
  const result = await run();
  expect(result.checks).toMatchObject([
    {
      status: "pass",
      recovery: "manual",
      context: {
        configuredHost: "unset",
        effectiveHost: "host-gateway",
        source: "default",
        windowsHost: "172.27.48.1",
        networkingMode: "nat",
        ideReachability: "unobserved",
      },
    },
  ]);
});

test("windows configuration reports the discovered NAT address without TCP", async () => {
  const result = await run("windows");
  expect(result.checks).toMatchObject([
    {
      status: "pass",
      context: {
        configuredHost: "windows",
        effectiveHost: "172.27.48.1",
        source: "windows-discovery",
        networkingMode: "nat",
        ideReachability: "unobserved",
      },
    },
  ]);
});

for (const host of ["192.0.2.40", "2001:db8::40"]) {
  test(`explicit ${host} never reads discovery files or executes a process`, async () => {
    const result = await run(host, {
      platform: "linux",
      readFile: async () => {
        throw new TypeError("unexpected file read");
      },
      runner: { run: () => Effect.die("unexpected process") },
    });
    expect(result.checks).toMatchObject([
      {
        status: "pass",
        context: {
          configuredHost: host,
          effectiveHost: host,
          source: "configured-address",
          networkingMode: "unobserved",
          ideReachability: "unobserved",
        },
      },
    ]);
  });
}

for (const [mode, release, reason] of [
  ["mirrored", "6.6-microsoft-standard-WSL2", "networking-mode"],
  ["nat", "linux", "not-wsl"],
] as const) {
  test(`discovery preserves typed ${reason} and manual remediation`, async () => {
    const result = await run("windows", discovery(mode, release));
    expect(result.checks).toMatchObject([
      {
        status: "warn",
        recovery: "manual",
        context: { failure: "DebuggerHostUnavailableError", reason, effectiveHost: "unresolved" },
      },
    ]);
    expect(result.checks[0]?.solutions[0]?.description).toContain("lando config");
    if (reason === "networking-mode") expect(result.checks[0]?.context.networkingMode).toBe("mirrored");
  });
}

test("wslinfo failure preserves the exact discovery reason", async () => {
  const result = await run("windows", {
    ...discovery(),
    runner: { run: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "denied" }) },
  });
  expect(result.checks[0]?.context.reason).toBe("wslinfo-failed");
});

test("missing wslinfo retains the engine's older-WSL NAT fallback", async () => {
  const result = await run("windows", {
    ...discovery(),
    runner: {
      run: () =>
        Effect.fail(
          new ProcessExecError({ message: "missing", cmd: "wslinfo", errno: -2, remediation: "install" }),
        ),
    },
  });
  expect(result.checks[0]?.context.networkingMode).toBe("nat");
});

test("route failure preserves the exact discovery reason", async () => {
  const result = await run("windows", {
    ...discovery(),
    readFile: async (path) =>
      path.endsWith("osrelease") ? "6.6-microsoft-standard-WSL2" : "no default route",
  });
  expect(result.checks[0]?.context.reason).toBe("no-default-route");
});

test("default discovery failure does not imply Windows is configured", async () => {
  const result = await run(undefined, discovery("mirrored"));
  expect(result.checks[0]?.context).toMatchObject({
    configuredHost: "unset",
    effectiveHost: "host-gateway",
    source: "default",
    reason: "networking-mode",
  });
});

test("discovery is bounded below the doctor section deadline", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const value = yield* debuggerHostDoctor((text) => text, 300, undefined, {
        ...discovery(),
        runner: { run: () => Effect.never },
      });
      return { value, elapsed: (yield* Clock.currentTimeMillis) - start };
    }).pipe(Effect.provideService(ConfigService, config("windows"))),
  );
  expect(result.value.checks[0]?.context).toMatchObject({ reason: "timeout", failure: "ProbeTimeoutError" });
  expect(result.elapsed).toBeLessThan(500);
});

test("redacts all context and remediation", async () => {
  const result = await Effect.runPromise(
    debuggerHostDoctor(() => "[redacted]", 1000, undefined, discovery("mirrored")).pipe(
      Effect.provideService(ConfigService, config("windows")),
    ),
  );
  expect(Object.values(result.checks[0]?.context ?? {}).every((value) => value === "[redacted]")).toBe(true);
  expect(result.checks[0]?.solutions[0]?.description).toBe("[redacted]");
});

test("report includes debugger check without changing schema or summary counts", async () => {
  const report = await Effect.runPromise(
    collectDoctorReport({
      options: { platform: "darwin" },
      provider: Effect.succeed({ checks: [] }),
      deprecations: Effect.succeed({ entries: [] }),
    }).pipe(Effect.provideService(ConfigService, config("192.0.2.40"))),
  );
  expect(Schema.is(DoctorReportSchema)(report)).toBe(true);
  expect(report.subsystems.checks.filter((check) => check.name === "debugger-host")).toHaveLength(1);
  const counts = countDoctorChecks(report);
  expect(counts.passed + counts.warned + counts.failed).toBe(
    report.provider.checks.length +
      report.subsystems.checks.length +
      report.globalApp.checks.length +
      report.mcp.checks.length +
      (report.self?.checks.length ?? 0),
  );
});
