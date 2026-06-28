import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";

import { StreamFrame } from "@lando/sdk/schema";
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
        expect(solution?.command).toBe("lando setup");
      }
    }
    const manual = failing.filter((check) => check.recovery === "manual");
    expect(manual.length).toBeGreaterThanOrEqual(1);
    expect(manual.every((check) => check.solutions[0]?.command === "lando setup")).toBe(true);
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

  test("runs with only the six subsystem layers", async () => {
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
