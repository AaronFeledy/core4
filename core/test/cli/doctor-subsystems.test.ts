import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";

import { ProxyService } from "@lando/sdk/services";

import {
  DefaultSubsystemDoctorLayer,
  type SubsystemDoctorResult,
  renderSubsystemDoctorResult,
  renderSubsystemDoctorResultAsNdjson,
  subsystemDoctor,
} from "../../src/cli/commands/doctor-subsystems.ts";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "meta-doctor.subsystems.ndjson");

const EXPECTED_SUBSYSTEMS = ["proxy", "certs", "ssh", "healthcheck", "scanner", "host-proxy"] as const;

const runDefault = (): Promise<SubsystemDoctorResult> =>
  Effect.runPromise(subsystemDoctor().pipe(Effect.provide(DefaultSubsystemDoctorLayer)));

describe("meta:doctor subsystem checks", () => {
  test("aggregates one check per subsystem with a {status, severity, context, solution} record", async () => {
    const result = await runDefault();

    expect(result.checks.map((check) => check.name)).toEqual([...EXPECTED_SUBSYSTEMS]);
    for (const check of result.checks) {
      expect(["pass", "warn", "fail"]).toContain(check.status);
      expect(["info", "warn", "error"]).toContain(check.severity);
      expect(check.context.subsystem).toBe(check.name);
      expect(typeof check.context.subsystemId).toBe("string");
      expect(Array.isArray(check.solutions)).toBe(true);
    }
  });

  test("covers at least one failing-state check carrying a manual remediation", async () => {
    const result = await runDefault();
    const failing = result.checks.filter((check) => check.status !== "pass");

    expect(failing.length).toBeGreaterThanOrEqual(1);
    for (const check of failing) {
      expect(check.solutions.length).toBeGreaterThanOrEqual(1);
      const solution = check.solutions[0];
      expect(solution?.kind).toBe("manual");
      expect(solution?.description.length).toBeGreaterThan(0);
      expect(solution?.command).toBe("lando setup");
    }
  });

  test("host-proxy check surfaces structured DNS status context", async () => {
    const result = await runDefault();
    const hostProxy = result.checks.find((check) => check.name === "host-proxy");

    expect(hostProxy).toBeDefined();
    expect(hostProxy?.context.active).toBe("false");
    expect(hostProxy?.context.mode).toBe("none");
    expect(hostProxy?.context.mechanism).toBe("skipped");
    expect(hostProxy?.context.baseDomain).toBe("lndo.site");
    expect(hostProxy?.context.loopback).toBe("127.0.0.1");
  });

  test("does not require app bootstrap — runs with only the six subsystem layers", async () => {
    // The effect is provided ONLY the subsystem layers (no ConfigService, no
    // AppPlanner, no app context). If it required app bootstrap this would not
    // typecheck or would fail at runtime with a missing-service defect.
    const result = await Effect.runPromise(
      subsystemDoctor().pipe(Effect.provide(DefaultSubsystemDoctorLayer)),
    );
    expect(result.checks.length).toBe(EXPECTED_SUBSYSTEMS.length);
  });

  test("reports a ready subsystem as pass with no remediation when a real implementation is wired", async () => {
    const readyProxy = Layer.succeed(ProxyService, {
      id: "traefik",
      setup: () => Effect.void,
      applyRoutes: () => Effect.void,
      removeRoutes: () => Effect.void,
    });
    const layer = Layer.mergeAll(DefaultSubsystemDoctorLayer, readyProxy);
    const result = await Effect.runPromise(subsystemDoctor().pipe(Effect.provide(layer)));
    const proxy = result.checks.find((check) => check.name === "proxy");

    expect(proxy?.status).toBe("pass");
    expect(proxy?.severity).toBe("info");
    expect(proxy?.context.ready).toBe("true");
    expect(proxy?.context.subsystemId).toBe("traefik");
    expect(proxy?.solutions).toEqual([]);
  });

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

  test("ndjson stream emits doctor.start, one doctor.check per subsystem, and doctor.complete with counts", async () => {
    const result = await runDefault();
    const ndjson = renderSubsystemDoctorResultAsNdjson(result, {
      now: new Date("1970-01-01T00:00:00.000Z"),
    });
    const lines = ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines[0]).toEqual({ _tag: "doctor.start", timestamp: "1970-01-01T00:00:00.000Z" });

    const checks = lines.slice(1, -1);
    expect(checks.map((check) => check.name)).toEqual([...EXPECTED_SUBSYSTEMS]);
    for (const check of checks) {
      expect(check._tag).toBe("doctor.check");
      expect(check).toHaveProperty("status");
      expect(check).toHaveProperty("severity");
      expect(check).toHaveProperty("context");
      expect(check).toHaveProperty("solutions");
    }

    const complete = lines.at(-1) as Record<string, unknown>;
    const warned = result.checks.filter((check) => check.status === "warn").length;
    const failed = result.checks.filter((check) => check.status === "fail").length;
    expect(complete).toEqual({
      _tag: "doctor.complete",
      timestamp: "1970-01-01T00:00:00.000Z",
      checks: result.checks.length,
      failed,
      warned,
    });
  });
});
