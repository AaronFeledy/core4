import { describe, expect, test } from "bun:test";
import {
  DestroyAppResult,
  DestroyOutcome,
  ObservedServiceRemoval,
  ServiceShutdownObservation,
  StopAppResult,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const identity = { appId: "demo", providerId: "test", service: "web", containerId: "exact-id" };
const diagnostic = {
  _tag: "ProviderUnavailableError",
  message: "Container inspection failed.",
  remediation: "Check the selected runtime endpoint.",
};
const roundTrip = <A, I>(schema: Schema.Codec<A, I>, value: unknown): A => {
  const decoded = Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });
  const encoded = Schema.encodeSync(schema)(decoded, { onExcessProperty: "error" });
  return Schema.decodeUnknownSync(schema)(encoded, { onExcessProperty: "error" });
};

describe("ServiceShutdownObservation", () => {
  test.each([0, 143, 137, undefined])("round-trips reported exit code %s without inference", (exitCode) => {
    const value = { ...identity, status: "exited", ...(exitCode === undefined ? {} : { exitCode }) };
    const result = roundTrip(ServiceShutdownObservation, value);
    expect<unknown>(result).toStrictEqual(value);
  });

  test.each([true, false, undefined])(
    "preserves explicit OOM %s independently of terminal state",
    (oomKilled) => {
      const value = {
        ...identity,
        status: "unknown",
        reason: "state-unavailable",
        ...(oomKilled === undefined ? {} : { oomKilled }),
      };
      const result = roundTrip(ServiceShutdownObservation, value);
      expect<unknown>(result).toStrictEqual(value);
    },
  );

  test.each(["container-absent", "state-unavailable", "not-exited", "inspect-failed"] as const)(
    "round-trips unknown reason %s",
    (reason) => {
      const value = {
        ...identity,
        status: "unknown",
        reason,
        ...(reason === "inspect-failed" ? { diagnostic } : {}),
      };
      const result = roundTrip(ServiceShutdownObservation, value);
      expect<unknown>(result).toStrictEqual(value);
    },
  );

  test.each(["container-absent", "state-unavailable", "not-exited", "inspect-failed"] as const)(
    "rejects a terminal exit code for unknown reason %s even with default excess stripping",
    (reason) => {
      const value = {
        ...identity,
        status: "unknown",
        reason,
        exitCode: 0,
        ...(reason === "inspect-failed" ? { diagnostic } : {}),
      };
      const result = Schema.decodeUnknownResult(ServiceShutdownObservation)(value);
      expect(Result.isFailure(result)).toBe(true);
    },
  );

  test.each([undefined, {}, { message: "failed" }, { ...diagnostic, remediation: "" }])(
    "rejects an inspect failure without a canonical diagnostic: %j",
    (diagnostic) => {
      const value = { ...identity, status: "unknown", reason: "inspect-failed", diagnostic };
      const result = Schema.decodeUnknownResult(ServiceShutdownObservation)(value);
      expect(Result.isFailure(result)).toBe(true);
    },
  );

  test.each([0.5, "0", null])("rejects noninteger exit code %j", (exitCode) => {
    const result = Schema.decodeUnknownResult(ServiceShutdownObservation)({
      ...identity,
      status: "exited",
      exitCode,
    });
    expect(Result.isFailure(result)).toBe(true);
  });

  test("permits absent exact container identity without inventing it", () => {
    const value = {
      appId: "demo",
      providerId: "test",
      service: "web",
      status: "unknown",
      reason: "container-absent",
    };
    const result = roundTrip(ServiceShutdownObservation, value);
    expect<unknown>(result).toStrictEqual(value);
  });

  test.each(["appId", "providerId", "service"])("requires attribution field %s", (field) => {
    const value = Object.fromEntries(
      Object.entries({ ...identity, status: "exited" }).filter(([key]) => key !== field),
    );
    const result = Schema.decodeUnknownResult(ServiceShutdownObservation)(value);
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("shutdown receipts", () => {
  const shutdownObservations = [
    { ...identity, status: "exited", exitCode: 137, oomKilled: false },
    { ...identity, appId: "other-app", status: "unknown", reason: "inspect-failed", diagnostic },
  ];

  test.each([
    ["destroyed", DestroyOutcome, { kind: "destroyed" }],
    ["no-op", DestroyOutcome, { kind: "no-op", reason: "no-applied-plan" }],
    ["removed", ObservedServiceRemoval, { kind: "removed" }],
    ["absent", ObservedServiceRemoval, { kind: "absent" }],
    ["app stop", StopAppResult, { app: "demo", servicesStopped: ["web"] }],
    [
      "app destroy",
      DestroyAppResult,
      { app: "demo", servicesDestroyed: ["web"], volumesRemoved: false, snapshotsRemoved: 0 },
    ],
  ] as const)("%s preserves observations or honest omission", (_name, schema, base) => {
    const legacy = roundTrip<unknown, unknown>(schema, base);
    const observed = roundTrip<unknown, unknown>(schema, { ...base, shutdownObservations });
    expect(legacy).toStrictEqual(base);
    expect(observed).toStrictEqual({ ...base, shutdownObservations });
  });

  test.each([{ kind: "no-op" }, { kind: "no-op", reason: "other" }, { kind: "unknown" }])(
    "rejects invalid provider destroy outcome %j",
    (value) => {
      const result = Schema.decodeUnknownResult(DestroyOutcome)(value);
      expect(Result.isFailure(result)).toBe(true);
    },
  );
});
