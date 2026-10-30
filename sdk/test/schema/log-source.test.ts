import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { LogSource, LogSourceId, LogSourceInput, ServiceInfoLogSource } from "@lando/sdk/schema";

describe("LogSourceId", () => {
  test("rejects the reserved console id", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(LogSourceId)("console"))).toBe(true);
  });

  test("rejects an empty id", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(LogSourceId)(""))).toBe(true);
  });

  test("accepts a normal id", () => {
    expect(Result.isSuccess(Schema.decodeUnknownResult(LogSourceId)("slow-query"))).toBe(true);
  });
});

describe("LogSource", () => {
  test("round trips a pathless native console alias", () => {
    // Given a logical name for a native daemon pipe.
    const input = { id: "access", label: "Access", stream: "stdout", strategy: "console" } as const;
    // When strictly decoding and encoding it.
    const decoded = Schema.decodeUnknownSync(LogSource, { onExcessProperty: "error" })(input);
    const encoded = Schema.encodeSync(LogSource)(decoded);
    // Then no file policy or path is invented, and authored files cannot encode it.
    expect(encoded).toEqual(input);
    expect(Schema.decodeUnknownSync(LogSource, { onExcessProperty: "error" })(encoded)).toEqual(decoded);
    expect(Result.isFailure(Schema.encodeUnknownResult(LogSourceInput)(decoded))).toBe(true);
  });

  test.each([{ path: "/tmp/log" }, { required: false }, { timestamps: false }])(
    "rejects file fields on console aliases even without excess-property checking (%j)",
    (fields) => {
      // Given a console alias with a forbidden file field.
      const input = { id: "error", stream: "stderr", strategy: "console", ...fields };
      // When decoding through the runtime boundary.
      const result = Schema.decodeUnknownResult(LogSource)(input);
      // Then the field cannot silently disappear.
      expect(Result.isFailure(result)).toBe(true);
    },
  );

  test("round trips pathless console info without a file availability state", () => {
    // Given a native alias projection.
    const input = { id: "error", stream: "stderr", strategy: "console", availability: "available" } as const;
    // When strictly decoding and encoding info.
    const decoded = Schema.decodeUnknownSync(ServiceInfoLogSource, { onExcessProperty: "error" })(input);
    // Then the wire representation remains pathless.
    expect(Schema.encodeSync(ServiceInfoLogSource)(decoded)).toEqual(input);
    expect(
      Result.isFailure(Schema.decodeUnknownResult(ServiceInfoLogSource)({ ...input, path: "/tmp/log" })),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ServiceInfoLogSource)({ ...input, availability: "redirected-to-console" }),
      ),
    ).toBe(true);
  });

  test("defaults required and timestamps to false", () => {
    const decoded = Schema.decodeUnknownSync(LogSource)({
      id: "error",
      path: "/var/log/apache2/error.log",
      stream: "stderr",
      strategy: "redirect",
    });

    expect(String(decoded.id)).toBe("error");
    expect(decoded.required).toBe(false);
    expect(decoded.timestamps).toBe(false);
    expect(decoded.label).toBeUndefined();
  });

  test("preserves explicit label, required, and timestamps", () => {
    const decoded = Schema.decodeUnknownSync(LogSource)({
      id: "slow-query",
      label: "MySQL slow query log",
      path: "/var/log/mysql/slow.log",
      stream: "stdout",
      strategy: "follow",
      required: true,
      timestamps: true,
    });

    expect(decoded.label).toBe("MySQL slow query log");
    expect(decoded.required).toBe(true);
    expect(decoded.timestamps).toBe(true);
  });

  test("rejects a declared source that reuses the reserved console id", () => {
    const result = Schema.decodeUnknownResult(LogSource)({
      id: "console",
      path: "/var/log/app.log",
      stream: "stderr",
      strategy: "follow",
    });

    expect(Result.isFailure(result)).toBe(true);
  });

  test("rejects an unknown strategy", () => {
    const result = Schema.decodeUnknownResult(LogSource)({
      id: "app",
      path: "/var/log/app.log",
      stream: "stderr",
      strategy: "sidecar",
    });

    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("LogSourceInput", () => {
  test.each([false, true])("preserves timestamps=%s through a strict encoded round trip", (timestamps) => {
    // Given an authored source with an explicit timestamp policy.
    const input = { path: "/tmp/app.log", timestamps };

    // When decoding and round-tripping through the authored shape.
    const decoded = Schema.decodeUnknownSync(LogSourceInput, { onExcessProperty: "error" })(input);
    const encoded = Schema.encodeSync(LogSourceInput)(decoded);
    const roundTripped = Schema.decodeUnknownSync(LogSourceInput, { onExcessProperty: "error" })(encoded);

    // Then timestamp handling survives both directions.
    expect(decoded.timestamps).toBe(timestamps);
    expect(encoded.timestamps).toBe(timestamps);
    expect(roundTripped).toEqual(decoded);
  });

  test("defaults id to the path basename, stream to stderr, and always follows", () => {
    const decoded = Schema.decodeUnknownSync(LogSourceInput)({
      path: "/var/log/apache2/error.log",
    });

    expect(String(decoded.id)).toBe("error.log");
    expect(decoded.stream).toBe("stderr");
    expect(decoded.strategy).toBe("follow");
    expect(decoded.timestamps).toBe(false);
    expect(decoded.required).toBe(false);
  });

  test("honors explicit id, label, and stream but still resolves to follow", () => {
    const decoded = Schema.decodeUnknownSync(LogSourceInput)({
      id: "app",
      label: "Application log",
      path: "/var/www/app/storage/logs/app.log",
      stream: "stdout",
    });

    expect(String(decoded.id)).toBe("app");
    expect(decoded.label).toBe("Application log");
    expect(decoded.stream).toBe("stdout");
    expect(decoded.strategy).toBe("follow");
  });

  test("rejects a user source whose path basename is the reserved console id", () => {
    const result = Schema.decodeUnknownResult(LogSourceInput)({
      path: "/var/log/console",
    });

    expect(Result.isFailure(result)).toBe(true);
  });

  test.each([
    { strategy: "redirect", required: false },
    { strategy: "follow", required: true },
  ])("rejects encoding sources outside the authored follow/optional contract (%j)", (policy) => {
    const source = Schema.decodeUnknownSync(LogSource)({
      id: "error",
      path: "/var/log/app.log",
      stream: "stderr",
      ...policy,
      timestamps: true,
    });
    const result = Schema.encodeUnknownResult(LogSourceInput)(source);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("Landofile log source input");
  });

  test.each([{ timestamps: "true" }, { strategy: "follow" }, { required: false }])(
    "rejects invalid authored fields when strictly decoding (%j)",
    (fields) => {
      const input = { path: "/tmp/app.log", ...fields };
      const result = Schema.decodeUnknownResult(LogSourceInput, { onExcessProperty: "error" })(input);
      expect(Result.isFailure(result)).toBe(true);
    },
  );

  test("encodes decoded Landofile input and decodes it back to the same source", () => {
    const decoded = Schema.decodeUnknownSync(LogSourceInput)({
      id: "app",
      label: "Application log",
      path: "/var/log/app.log",
      stream: "stdout",
    });

    const encoded = Schema.encodeSync(LogSourceInput)(decoded);
    const decodedAgain = Schema.decodeUnknownSync(LogSourceInput)(encoded);

    expect(encoded).toEqual({
      id: "app",
      label: "Application log",
      path: "/var/log/app.log",
      stream: "stdout",
      timestamps: false,
    });
    expect(decodedAgain).toEqual(decoded);
  });
});
