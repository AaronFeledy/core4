import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { type HostPlatform, PluginDoctorReport } from "@lando/sdk/schema";

import { makeRouterBindAddressCheck, routerBindAddressCheck } from "../src/doctor-bind-address.ts";
import {
  DEFAULT_ROUTER_BIND_ADDRESS,
  UNSPECIFIED_BIND_REMEDIATION,
  classifyRouterBindAddress,
  resolveRouterBindAddress,
  routerBindAddressFromEnv,
} from "../src/router-bind-address.ts";

const runCheck = (
  env: Readonly<Record<string, string | undefined>> = {},
  platform: HostPlatform = "linux",
  resolveBind?: (inputEnv: Readonly<Record<string, string | undefined>>) => Effect.Effect<string>,
) =>
  Effect.runPromise(
    (resolveBind === undefined ? routerBindAddressCheck : makeRouterBindAddressCheck(resolveBind)).run({
      providerId: "lando",
      platform,
      env,
      userDataRoot: undefined,
      binDir: undefined,
      stateDir: undefined,
    }),
  );

const decodeReport = (report: unknown): PluginDoctorReport =>
  Schema.decodeUnknownSync(PluginDoctorReport)(report);

describe("classifyRouterBindAddress", () => {
  test("treats loopback spellings as loopback", () => {
    expect(classifyRouterBindAddress("127.0.0.1")).toBe("loopback");
    expect(classifyRouterBindAddress("::1")).toBe("loopback");
    expect(classifyRouterBindAddress("[::1]")).toBe("loopback");
    expect(classifyRouterBindAddress("127.0.0.2")).toBe("loopback");
  });

  test("treats unspecified binds as unspecified", () => {
    expect(classifyRouterBindAddress("0.0.0.0")).toBe("unspecified");
    expect(classifyRouterBindAddress("::")).toBe("unspecified");
    expect(classifyRouterBindAddress("[::]")).toBe("unspecified");
  });

  test("treats a specific non-loopback IP as specific", () => {
    expect(classifyRouterBindAddress("192.168.1.10")).toBe("specific");
    expect(classifyRouterBindAddress("10.0.0.5")).toBe("specific");
  });
});

describe("resolveRouterBindAddress", () => {
  test("defaults to loopback when nothing is configured", () => {
    expect(resolveRouterBindAddress({})).toBe(DEFAULT_ROUTER_BIND_ADDRESS);
  });

  test("honors LANDO_ROUTER_BIND_ADDRESS", () => {
    expect(routerBindAddressFromEnv({ LANDO_ROUTER_BIND_ADDRESS: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveRouterBindAddress({ env: { LANDO_ROUTER_BIND_ADDRESS: "10.0.0.8" } })).toBe("10.0.0.8");
  });

  test("prefers an explicit configured bind over env", () => {
    expect(
      resolveRouterBindAddress({
        configured: "192.168.1.4",
        env: { LANDO_ROUTER_BIND_ADDRESS: "0.0.0.0" },
      }),
    ).toBe("192.168.1.4");
  });
});

describe("routerBindAddressCheck", () => {
  test("loopback default passes", async () => {
    // Given: no router bind overlay.
    // When: the doctor contribution runs.
    const reports = await runCheck();

    // Then: one pass report decodes and names loopback.
    expect(reports).toHaveLength(1);
    const report = decodeReport(reports[0]);
    expect(report).toMatchObject({
      name: "router-bind-address",
      status: "pass",
      severity: "info",
      runtimeStatus: "loopback",
      context: { bindAddress: DEFAULT_ROUTER_BIND_ADDRESS, kind: "loopback" },
    });
    expect(report.solutions).toEqual([]);
  });

  test("warns when bind is 0.0.0.0", async () => {
    // Given: an unspecified IPv4 bind.
    const reports = await runCheck({}, "linux", () => Effect.succeed("0.0.0.0"));

    // Then: one warn names LAN exposure and remediates to loopback.
    expect(reports).toHaveLength(1);
    const report = decodeReport(reports[0]);
    expect(report).toMatchObject({
      name: "router-bind-address",
      status: "warn",
      severity: "warn",
      runtimeStatus: UNSPECIFIED_BIND_REMEDIATION,
      context: { bindAddress: "0.0.0.0", kind: "unspecified" },
    });
    expect(report.solutions).toEqual([
      { kind: "manual", description: UNSPECIFIED_BIND_REMEDIATION },
    ]);
  });

  test("warns when bind is ::", async () => {
    // Given: an unspecified IPv6 bind.
    const reports = await runCheck({}, "linux", () => Effect.succeed("::"));

    // Then: one warn uses the same LAN-exposure remediation.
    expect(reports).toHaveLength(1);
    const report = decodeReport(reports[0]);
    expect(report.status).toBe("warn");
    expect(report.severity).toBe("warn");
    expect(report.context.bindAddress).toBe("::");
    expect(report.context.kind).toBe("unspecified");
    expect(report.runtimeStatus).toBe(UNSPECIFIED_BIND_REMEDIATION);
  });

  test("reports a specific IP as intentional LAN sharing", async () => {
    // Given: a specific non-loopback interface IP.
    const reports = await runCheck({}, "linux", () => Effect.succeed("192.168.1.20"));

    // Then: pass + info, not an error, with an intentional-sharing note.
    expect(reports).toHaveLength(1);
    const report = decodeReport(reports[0]);
    expect(report).toMatchObject({
      name: "router-bind-address",
      status: "pass",
      severity: "info",
      runtimeStatus: "intentional LAN sharing",
      context: {
        bindAddress: "192.168.1.20",
        kind: "specific",
        note: "intentional LAN sharing",
      },
    });
    expect(report.status).not.toBe("fail");
  });

  test("honors LANDO_ROUTER_BIND_ADDRESS", async () => {
    // Given: the friendly env overlay sets an unspecified bind.
    const reports = await runCheck({ LANDO_ROUTER_BIND_ADDRESS: "0.0.0.0" });

    // Then: the check reports that address as a LAN-exposure warn.
    expect(reports).toHaveLength(1);
    const report = decodeReport(reports[0]);
    expect(report.context.bindAddress).toBe("0.0.0.0");
    expect(report.status).toBe("warn");
    expect(report.severity).toBe("warn");
  });
});
