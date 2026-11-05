import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { StreamFrame } from "@lando/sdk/schema";
import { PathsService, RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";

import * as BunFileSystem from "@lando/engine/services/file-system";
import type { CertsDoctorStatus } from "../../src/cli/commands/doctor-certs-status.ts";
import { HostDnsResolver } from "../../src/cli/commands/doctor-host-dns.ts";
import { HOST_DNS_SPEC, PROXY_SPEC } from "../../src/cli/commands/doctor-subsystem-checks.ts";
import {
  type SubsystemDoctorResult,
  renderSubsystemDoctorResult,
  renderSubsystemDoctorResultAsNdjson,
  subsystemDoctor,
} from "../../src/cli/commands/doctor-subsystems.ts";
import { DefaultSubsystemDoctorLayer } from "./doctor-subsystem-fixture.ts";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "meta-doctor.subsystems.ndjson");

const EXPECTED_SUBSYSTEMS = ["router", "certs", "ssh", "host-dns"] as const;

const dnsLayer = (addresses: ReadonlyArray<string>) =>
  Layer.succeed(HostDnsResolver, HostDnsResolver.of({ lookup: () => Effect.succeed(addresses) }));

const runDefault = (): Promise<SubsystemDoctorResult> =>
  Effect.runPromise(
    subsystemDoctor().pipe(Effect.provide(dnsLayer([])), Effect.provide(DefaultSubsystemDoctorLayer)),
  );

const decodeFrames = (ndjson: string) =>
  ndjson
    .trimEnd()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));

const eventPayloads = (ndjson: string): ReadonlyArray<Record<string, unknown>> =>
  decodeFrames(ndjson).flatMap((frame) =>
    frame._tag === "event" ? [frame.payload as Record<string, unknown>] : [],
  );

const resultEnvelope = (ndjson: string) => {
  const frame = decodeFrames(ndjson).at(-1);
  if (frame?._tag !== "result") throw new Error("expected terminal result frame");
  return frame.envelope;
};

const writeAcquisitionState = (
  mode: string,
): { readonly layer: Layer.Layer<PathsService>; readonly cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "lando-doctor-acquisition-"));
  const paths = makeLandoPaths({ userDataRoot: root });
  const stateFile = join(paths.globalAppRoot, "proxy-traefik", "dynamic", ".lando-port-acquisition.json");
  mkdirSync(join(stateFile, ".."), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify({ mode, httpPort: 8080, httpsPort: 8443, notices: [] })}\n`);
  return {
    layer: Layer.succeed(PathsService, paths),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

describe("meta:doctor subsystem checks", () => {
  test("names ingress and host DNS checks distinctly", () => {
    expect(PROXY_SPEC.name).toBe("router");
    expect(HOST_DNS_SPEC.name).toBe("host-dns");
  });

  test("aggregates one check per subsystem with a {status, severity, context, solution} record", async () => {
    const result = await runDefault();

    expect(result.checks.map((check) => check.name)).toEqual([...EXPECTED_SUBSYSTEMS]);
    for (const check of result.checks) {
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(["info", "warn", "error"]).toContain(check.severity);
      expect(check.context.subsystem).toBe(check.name);
      if (check.name !== "host-dns") expect(typeof check.context.subsystemId).toBe("string");
      expect(Array.isArray(check.solutions)).toBe(true);
    }
  });

  test("covers a failing-state check per subsystem with a recovery-classified solution", async () => {
    const result = await runDefault();
    const failing = result.checks.filter((check) => check.status !== "pass");

    expect(failing.length).toBeGreaterThanOrEqual(1);
    for (const check of failing) {
      expect(check.solutions.length).toBeGreaterThanOrEqual(1);
      const solution = check.solutions[0];
      expect(solution?.description.length).toBeGreaterThan(0);
      if (check.recovery === "automatic") {
        expect(solution?.kind).toBe("automatic");
        expect(solution?.command).toBe("lando doctor --fix");
      } else {
        expect(solution?.kind).toBe("manual");
        if (check.name !== "host-dns") expect(solution?.command).toBeDefined();
      }
    }
    const manual = failing.filter((check) => check.recovery === "manual");
    expect(manual.length).toBeGreaterThanOrEqual(1);
    expect(
      manual
        .filter((check) => check.name !== "host-dns")
        .every((check) => check.solutions[0]?.command === "lando setup"),
    ).toBe(true);
  });

  test("host-dns check surfaces structured DNS observations", async () => {
    const result = await runDefault();
    const hostDns = result.checks.find((check) => check.name === "host-dns");

    expect(hostDns?.context).toEqual({
      subsystem: "host-dns",
      baseDomain: "lndo.site",
      loopback: "127.0.0.1",
      dnsHostname: "lando-doctor-probe.lndo.site",
      dnsResolved: "false",
    });
  });

  test("passes host DNS when the hostname resolves to loopback", async () => {
    const result = await Effect.runPromise(
      subsystemDoctor().pipe(
        Effect.provide(dnsLayer(["127.0.0.1"])),
        Effect.provide(DefaultSubsystemDoctorLayer),
      ),
    );
    const hostDns = result.checks.find((check) => check.name === "host-dns");
    expect(hostDns).toMatchObject({
      status: "pass",
      severity: "info",
      context: {
        dnsHostname: "lando-doctor-probe.lndo.site",
        dnsResolved: "true",
      },
      solutions: [],
    });
  });

  test("warns with manual DNS remediation when the resolver cannot resolve hostnames", async () => {
    const result = await runDefault();
    const hostProxy = result.checks.find((check) => check.name === "host-dns");
    expect(hostProxy?.status).toBe("warn");
    expect(hostProxy?.context.dnsResolved).toBe("false");
    expect(hostProxy?.solutions[0]?.description).toContain("Add a local DNS rule");
    expect(hostProxy?.solutions[0]?.command).toBeUndefined();
  });

  test("warns when host DNS resolves away from the configured loopback", async () => {
    const result = await Effect.runPromise(
      subsystemDoctor().pipe(
        Effect.provide(dnsLayer(["192.0.2.1"])),
        Effect.provide(DefaultSubsystemDoctorLayer),
      ),
    );
    const hostProxy = result.checks.find((check) => check.name === "host-dns");
    expect(hostProxy?.status).toBe("warn");
    expect(hostProxy?.context.dnsAddresses).toBe("192.0.2.1");
  });

  test("skips manual DNS recovery when fix is requested", async () => {
    const result = await Effect.runPromise(subsystemDoctor({ fix: true }).pipe(Effect.provide(dnsLayer([]))));
    const hostProxy = result.checks.find((check) => check.name === "host-dns");
    expect(hostProxy?.status).toBe("warn");
    expect(hostProxy?.context.fixOutcome).toBe("skipped-manual");
    expect(hostProxy?.context.dnsResolved).toBe("false");
    expect(hostProxy?.solutions[0]?.kind).toBe("manual");
    expect(hostProxy?.solutions[0]?.command).toBeUndefined();
  });

  test("reports lookup failures as unresolved without leaking resolver errors", async () => {
    const result = await Effect.runPromise(
      subsystemDoctor().pipe(
        Effect.provide(
          Layer.succeed(
            HostDnsResolver,
            HostDnsResolver.of({
              lookup: () => Effect.fail(new Error("sensitive resolver detail")),
            }),
          ),
        ),
        Effect.provide(DefaultSubsystemDoctorLayer),
      ),
    );
    const hostProxy = result.checks.find((check) => check.name === "host-dns");
    expect(hostProxy?.status).toBe("warn");
    expect(hostProxy?.context.dnsResolved).toBe("false");
    expect(JSON.stringify(hostProxy)).not.toContain("sensitive resolver detail");
  });

  test("bounds a stalled host DNS lookup and reports it as unresolved", async () => {
    const started = performance.now();
    const result = await Effect.runPromise(
      subsystemDoctor().pipe(
        Effect.provide(Layer.succeed(HostDnsResolver, HostDnsResolver.of({ lookup: () => Effect.never }))),
        Effect.provide(DefaultSubsystemDoctorLayer),
      ),
    );
    const hostProxy = result.checks.find((check) => check.name === "host-dns");
    expect(hostProxy?.status).toBe("warn");
    expect(hostProxy?.context.dnsResolved).toBe("false");
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("runs with only the six subsystem layers", async () => {
    const result = await Effect.runPromise(
      subsystemDoctor().pipe(Effect.provide(DefaultSubsystemDoctorLayer)),
    );
    expect(result.checks.length).toBe(EXPECTED_SUBSYSTEMS.length);
  });

  test("uses the selected certificate authority id from precomputed status", async () => {
    // Given / When
    const result = await Effect.runPromise(
      subsystemDoctor({ certs: { _tag: "selected", id: "mkcert" } }).pipe(
        Effect.provide(DefaultSubsystemDoctorLayer),
      ),
    );

    // Then
    const certs = result.checks.find((check) => check.name === "certs");
    expect(certs).toBeUndefined();
    expect(result.skipped).toContainEqual({
      section: "certs",
      status: "skipped",
      reason: expect.any(String),
    });
  });

  test("preserves tagged certificate resolution context for degraded statuses", async () => {
    // Given
    const cases: ReadonlyArray<{
      readonly status: CertsDoctorStatus;
      readonly context: Readonly<Record<string, string>>;
    }> = [
      {
        status: { _tag: "unresolved" },
        context: {},
      },
      {
        status: { _tag: "ambiguous", candidateIds: ["first", "second"], detail: "choose one" },
        context: {
          certsReason: "ambiguous",
          certsCandidateIds: "first,second",
          certsDetail: "choose one",
        },
      },
      {
        status: { _tag: "load-failed", pluginName: "ca-plugin", detail: "load failed" },
        context: {
          certsReason: "load-failed",
          certsPlugin: "ca-plugin",
          certsDetail: "load failed",
        },
      },
    ];

    for (const fixture of cases) {
      // When
      const result = await Effect.runPromise(
        subsystemDoctor({ certs: fixture.status }).pipe(Effect.provide(DefaultSubsystemDoctorLayer)),
      );

      // Then
      const certs = result.checks.find((check) => check.name === "certs");
      expect(certs?.status).toBe("warn");
      expect(certs?.context).toEqual({
        subsystem: "certs",
        subsystemId: "unavailable",
        ready: "false",
        ...fixture.context,
      });
      expect(certs?.solutions[0]?.command).toBe("lando setup");
    }
  });

  test("reports a ready subsystem as pass with no remediation when a real implementation is wired", async () => {
    const proxyService = RouterService.of({ ...makeTestRouterService(), id: "traefik" });
    await Effect.runPromise(Effect.scoped(proxyService.setup({ defaultDomain: "lndo.site" })));
    const readyProxy = Layer.succeed(RouterService, proxyService);
    const layer = Layer.mergeAll(DefaultSubsystemDoctorLayer, readyProxy);
    const result = await Effect.runPromise(subsystemDoctor().pipe(Effect.provide(layer)));
    const proxy = result.checks.find((check) => check.name === "router");

    expect(proxy?.status).toBe("pass");
    expect(proxy?.severity).toBe("info");
    expect(proxy?.context.ready).toBe("true");
    expect(proxy?.context.subsystemId).toBe("traefik");
    expect(proxy?.context.state).toBe("running");
    expect(proxy?.solutions).toEqual([]);
  });

  test("reports a selected-but-stopped proxy as warn with automatic doctor --fix", async () => {
    const stoppedProxy = Layer.succeed(
      RouterService,
      RouterService.of({
        ...makeTestRouterService(),
        id: "traefik",
      }),
    );
    const layer = Layer.mergeAll(DefaultSubsystemDoctorLayer, stoppedProxy);
    const result = await Effect.runPromise(subsystemDoctor().pipe(Effect.provide(layer)));
    const proxy = result.checks.find((check) => check.name === "router");

    expect(proxy?.status).toBe("warn");
    expect(proxy?.severity).toBe("warn");
    expect(proxy?.recovery).toBe("automatic");
    expect(proxy?.context.ready).toBe("false");
    expect(proxy?.context.subsystemId).toBe("traefik");
    expect(proxy?.context.state).toBe("stopped");
    expect(proxy?.solutions[0]?.kind).toBe("automatic");
    expect(proxy?.solutions[0]?.command).toBe("lando doctor --fix");
  });

  test("surfaces needs-helper remediation from persisted acquisition state", async () => {
    // Given
    const acquisition = writeAcquisitionState("needs-helper");
    const proxyService = RouterService.of({ ...makeTestRouterService(), id: "traefik" });
    await Effect.runPromise(Effect.scoped(proxyService.setup({ defaultDomain: "lndo.site" })));
    const layer = Layer.mergeAll(
      DefaultSubsystemDoctorLayer,
      Layer.succeed(RouterService, proxyService),
      acquisition.layer,
      BunFileSystem.layer,
    );

    try {
      // When
      const result = await Effect.runPromise(subsystemDoctor().pipe(Effect.provide(layer)));
      const proxy = result.checks.find((check) => check.name === "router");

      // Then
      expect(proxy?.context.acquisitionMode).toBe("needs-helper");
      expect(proxy?.status).toBe("warn");
      expect(proxy?.solutions[0]?.command).toBe("lando doctor --fix");
      expect(proxy?.solutions[0]?.description).toContain(":8080/:8443");
      expect(proxy?.solutions[0]?.description).not.toContain(":38080");
    } finally {
      acquisition.cleanup();
    }
  });

  test("does not report proxy --fix recovered while acquisition stays needs-helper", async () => {
    // Given
    const acquisition = writeAcquisitionState("needs-helper");
    const proxyService = RouterService.of({ ...makeTestRouterService(), id: "traefik" });
    await Effect.runPromise(Effect.scoped(proxyService.setup({ defaultDomain: "lndo.site" })));
    const layer = Layer.mergeAll(
      DefaultSubsystemDoctorLayer,
      Layer.succeed(RouterService, proxyService),
      acquisition.layer,
      BunFileSystem.layer,
    );

    try {
      // When
      const result = await Effect.runPromise(subsystemDoctor({ fix: true }).pipe(Effect.provide(layer)));
      const proxy = result.checks.find((check) => check.name === "router");

      // Then
      expect(proxy?.status).toBe("warn");
      expect(proxy?.context.fixOutcome).not.toBe("recovered");
      expect(proxy?.context.acquisitionMode).toBe("needs-helper");
    } finally {
      acquisition.cleanup();
    }
  });

  test("does not report proxy --fix recovered while acquisition stays occupied-hop", async () => {
    const acquisition = writeAcquisitionState("occupied-hop");
    const proxyService = RouterService.of({ ...makeTestRouterService(), id: "traefik" });
    await Effect.runPromise(Effect.scoped(proxyService.setup({ defaultDomain: "lndo.site" })));
    const layer = Layer.mergeAll(
      DefaultSubsystemDoctorLayer,
      Layer.succeed(RouterService, proxyService),
      acquisition.layer,
      BunFileSystem.layer,
    );
    try {
      const result = await Effect.runPromise(subsystemDoctor({ fix: true }).pipe(Effect.provide(layer)));
      const proxy = result.checks.find((check) => check.name === "router");
      expect(proxy?.status).toBe("warn");
      expect(proxy?.context.fixOutcome).not.toBe("recovered");
    } finally {
      acquisition.cleanup();
    }
  });

  test("surfaces occupied-hop remediation from persisted acquisition state", async () => {
    // Given
    const acquisition = writeAcquisitionState("occupied-hop");
    const proxyService = RouterService.of({ ...makeTestRouterService(), id: "traefik" });
    await Effect.runPromise(Effect.scoped(proxyService.setup({ defaultDomain: "lndo.site" })));
    const layer = Layer.mergeAll(
      DefaultSubsystemDoctorLayer,
      Layer.succeed(RouterService, proxyService),
      acquisition.layer,
      BunFileSystem.layer,
    );

    try {
      // When
      const result = await Effect.runPromise(subsystemDoctor().pipe(Effect.provide(layer)));
      const proxy = result.checks.find((check) => check.name === "router");

      // Then
      expect(proxy?.context.acquisitionMode).toBe("occupied-hop");
      expect(proxy?.status).toBe("warn");
      expect(proxy?.context.httpPort).toBe("8080");
      expect(proxy?.context.httpsPort).toBe("8443");
      expect(proxy?.solutions[0]?.description).toContain("8080");
      expect(proxy?.solutions[0]?.description).toContain("8443");
      expect(proxy?.solutions[0]?.description).toContain("lando info");
      expect(proxy?.solutions[0]?.command).toBe("lando setup");
      expect(proxy?.solutions[0]?.description).not.toContain("38080");
    } finally {
      acquisition.cleanup();
    }
  });

  test("uses setup advice when occupied-hop router is stopped", async () => {
    const acquisition = writeAcquisitionState("occupied-hop");
    const proxyService = RouterService.of({ ...makeTestRouterService(), id: "traefik" });
    const layer = Layer.mergeAll(
      DefaultSubsystemDoctorLayer,
      Layer.succeed(RouterService, proxyService),
      acquisition.layer,
      BunFileSystem.layer,
    );
    try {
      const result = await Effect.runPromise(subsystemDoctor().pipe(Effect.provide(layer)));
      const proxy = result.checks.find((check) => check.name === "router");
      expect(proxy?.status).toBe("warn");
      expect(proxy?.context.ready).toBe("false");
      expect(proxy?.solutions[0]?.command).toBe("lando setup");
      expect(proxy?.solutions[0]?.description).toContain("any occupied preferred ports");
      expect(proxy?.solutions[0]?.description).toContain("Lando last selected HTTP");
    } finally {
      acquisition.cleanup();
    }
  });

  test.each([false, true])(
    "skips uninspected subsystems with runtime services provided=%s",
    async (provided) => {
      // Given a runtime with or without the inspectable subsystem services.
      const runtime = provided ? DefaultSubsystemDoctorLayer : dnsLayer([]);
      // When doctor inspects that runtime.
      const result = await Effect.runPromise(subsystemDoctor().pipe(Effect.provide(runtime)));
      // Then missing services and unexecuted probes never become passing checks.
      const healthcheck = result.checks.find((check) => check.name === "healthcheck");
      const scanner = result.checks.find((check) => check.name === "scanner");

      expect(healthcheck).toBeUndefined();
      expect(scanner).toBeUndefined();
      expect(result.checks.map((check) => check.name)).toEqual(
        provided ? [...EXPECTED_SUBSYSTEMS] : ["certs", "host-dns"],
      );
      expect(result.skipped?.map((entry) => entry.section)).toEqual(
        provided ? ["healthcheck", "scanner"] : ["router", "ssh", "healthcheck", "scanner"],
      );
      for (const entry of result.skipped ?? []) {
        expect(entry.status).toBe("skipped");
        expect(entry.reason.length).toBeGreaterThan(0);
      }
    },
  );

  test("plain-text renderer surfaces every subsystem name, status, and remediation", async () => {
    const result = await runDefault();
    const text = renderSubsystemDoctorResult(result);

    for (const name of EXPECTED_SUBSYSTEMS) {
      expect(text).toContain(`${name}:`);
    }
    expect(text).toContain("severity: warn");
    expect(text).toContain("solution[manual]:");
    expect(text).toContain("lando setup");
    expect(text).not.toContain("[object Object]");
  });

  test("ndjson output matches the meta-doctor.subsystems.ndjson fixture", async () => {
    const result = await runDefault();
    const actual = renderSubsystemDoctorResultAsNdjson(result, {
      now: new Date("1970-01-01T00:00:00.000Z"),
    });
    const expected = readFileSync(FIXTURE_PATH, "utf-8");

    expect(actual).toBe(expected);
  });

  test("ndjson stream emits one doctor.check event frame per subsystem and a terminal result frame", async () => {
    const result = await runDefault();
    const ndjson = renderSubsystemDoctorResultAsNdjson(result, {
      now: new Date("1970-01-01T00:00:00.000Z"),
    });
    const frames = decodeFrames(ndjson);
    expect(frames.at(-1)?._tag).toBe("result");
    const checks = eventPayloads(ndjson);
    expect(checks.map((check) => check.name)).toEqual([...EXPECTED_SUBSYSTEMS]);
    for (const check of checks) {
      expect(check._tag).toBe("doctor.check");
      expect(check).toHaveProperty("status");
      expect(check).toHaveProperty("severity");
      expect(check).toHaveProperty("context");
      expect(check).toHaveProperty("solutions");
    }

    const warned = result.checks.filter((check) => check.status === "warn").length;
    const failed = result.checks.filter((check) => check.status === "fail").length;
    expect(resultEnvelope(ndjson)).toMatchObject({
      command: "meta:doctor",
      ok: true,
      result: {
        timestamp: "1970-01-01T00:00:00.000Z",
        checks: result.checks.length,
        failed,
        warned,
      },
    });
  });
});
