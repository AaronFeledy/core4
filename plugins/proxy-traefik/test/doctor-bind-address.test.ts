import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { type HostPlatform, PluginDoctorReport } from "@lando/sdk/schema";

import { makeRouterBindAddressCheck, routerBindAddressCheck } from "../src/doctor-bind-address.ts";
import { buildTraefikServiceConfig } from "../src/global-services/traefik.ts";
import { resolveTryLists } from "../src/port-acquisition-helpers.ts";
import { acquisitionStateFile } from "../src/proxy-paths.ts";
import type { TraefikProxyDependencies } from "../src/proxy-types.ts";
import {
  DEFAULT_ROUTER_BIND_ADDRESS,
  UNSPECIFIED_BIND_REMEDIATION,
  classifyRouterBindAddress,
  normalizeRouterBindAddress,
  resolvePublishedRouterBindAddress,
  resolveRouterBindAddress,
  routerBindAddressFromEnv,
} from "../src/router-bind-address.ts";

const runCheck = (
  env: Readonly<Record<string, string | undefined>> = {},
  platform: HostPlatform = "linux",
  resolveBind?: (inputEnv: Readonly<Record<string, string | undefined>>) => Effect.Effect<string>,
  userDataRoot?: string,
) =>
  Effect.runPromise(
    (resolveBind === undefined ? routerBindAddressCheck : makeRouterBindAddressCheck(resolveBind)).run({
      providerId: "lando",
      platform,
      env,
      userDataRoot,
      binDir: undefined,
      stateDir: undefined,
    }),
  );

const withAcquisitionFile = (
  bindAddress: string,
): { readonly userDataRoot: string; readonly cleanup: () => void } => {
  const userDataRoot = mkdtempSync(join(tmpdir(), "lando-bind-acq-"));
  const paths = makeLandoPaths({ userDataRoot, platform: "linux" });
  const stateFile = acquisitionStateFile({
    platform: paths.platform,
    globalAppRoot: paths.globalAppRoot,
  });
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    `${JSON.stringify({
      mode: "occupied-hop",
      httpPort: 8080,
      httpsPort: 8443,
      notices: [],
      fingerprint: { http: [8080], https: [8443], bindAddress },
    })}\n`,
  );
  return {
    userDataRoot,
    cleanup: () => rmSync(userDataRoot, { recursive: true, force: true }),
  };
};

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
    expect(report.runtime).toBeUndefined();
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
    expect(report.solutions).toEqual([{ kind: "manual", description: UNSPECIFIED_BIND_REMEDIATION }]);
    expect(report.runtime).toBeUndefined();
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
    expect(report.runtime).toBeUndefined();
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

  test("normalizes localhost to 127.0.0.1 before classifying", async () => {
    // Given: a hostname bind that Docker cannot publish.
    const reports = await runCheck({}, "linux", () => Effect.succeed("localhost"));

    // Then: the check reports the IPv4 loopback publish address.
    expect(reports).toHaveLength(1);
    const report = decodeReport(reports[0]);
    expect(report).toMatchObject({
      name: "router-bind-address",
      status: "pass",
      severity: "info",
      runtimeStatus: "loopback",
      context: { bindAddress: DEFAULT_ROUTER_BIND_ADDRESS, kind: "loopback" },
    });
    expect(report.runtime).toBeUndefined();
  });

  test("reads the persisted acquisition fingerprint over env", async () => {
    // Given: setup already acquired 10.0.0.8 while env asks for every interface.
    const acquisition = withAcquisitionFile("10.0.0.8");
    try {
      const reports = await runCheck(
        { LANDO_ROUTER_BIND_ADDRESS: "0.0.0.0" },
        "linux",
        undefined,
        acquisition.userDataRoot,
      );

      // Then: doctor reports the persisted bind, not the env overlay.
      expect(reports).toHaveLength(1);
      const report = decodeReport(reports[0]);
      expect(report).toMatchObject({
        name: "router-bind-address",
        status: "pass",
        severity: "info",
        runtimeStatus: "intentional LAN sharing",
        context: { bindAddress: "10.0.0.8", kind: "specific", note: "intentional LAN sharing" },
      });
    } finally {
      acquisition.cleanup();
    }
  });
});

describe("publication, probes, display, and doctor agree", () => {
  test("share the persisted fingerprint bind after Landofile bind is ignored", async () => {
    // Given: global bind 10.0.0.8, a widening Landofile bind, and a matching acquisition fingerprint.
    const configured = "10.0.0.8";
    const persisted = "10.0.0.8";
    const lists = resolveTryLists({
      router: { bindAddress: configured },
      paths: { platform: "linux", globalAppRoot: "/tmp" },
    } as TraefikProxyDependencies);
    const published = buildTraefikServiceConfig({
      http: 8080,
      https: 8443,
      bindAddress: resolvePublishedRouterBindAddress(persisted, "0.0.0.0"),
    });
    const displayHost = persisted === "0.0.0.0" ? "127.0.0.1" : persisted === "::" ? "::1" : persisted;
    const acquisition = withAcquisitionFile(persisted);

    try {
      const reports = await runCheck(
        { LANDO_ROUTER_BIND_ADDRESS: "0.0.0.0" },
        "linux",
        undefined,
        acquisition.userDataRoot,
      );
      const report = decodeReport(reports[0]);

      // Then: probes, publication, display, and doctor all use 10.0.0.8.
      expect(lists.bindAddress).toBe(configured);
      expect(lists.fingerprint.bindAddress).toBe(configured);
      expect(
        published.endpoints
          ?.filter((endpoint) => endpoint._tag === "published")
          .map((endpoint) => endpoint.publication.bindAddress),
      ).toEqual([configured, configured]);
      expect(displayHost).toBe(configured);
      expect(report.context.bindAddress).toBe(configured);
    } finally {
      acquisition.cleanup();
    }
  });
});

describe("normalizeRouterBindAddress", () => {
  test("rewrites localhost to 127.0.0.1", () => {
    expect(normalizeRouterBindAddress("localhost")).toBe(DEFAULT_ROUTER_BIND_ADDRESS);
    expect(normalizeRouterBindAddress("LOCALHOST")).toBe(DEFAULT_ROUTER_BIND_ADDRESS);
    expect(normalizeRouterBindAddress("[localhost]")).toBe(DEFAULT_ROUTER_BIND_ADDRESS);
    expect(normalizeRouterBindAddress("0.0.0.0")).toBe("0.0.0.0");
  });
});
