import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import { LogSource, LogSourceId, LogSourceInput } from "@lando/sdk/schema";

describe("LogSourceId", () => {
  test("rejects the reserved console id", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(LogSourceId)("console"))).toBe(true);
  });

  test("rejects an empty id", () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(LogSourceId)(""))).toBe(true);
  });

  test("accepts a normal id", () => {
    expect(Either.isRight(Schema.decodeUnknownEither(LogSourceId)("slow-query"))).toBe(true);
  });
});

describe("LogSource", () => {
  test("defaults required and timestamps to false", () => {
    const decoded = Schema.decodeUnknownSync(LogSource)({
      id: "error",
      path: "/var/log/apache2/error.log",
      stream: "stderr",
      strategy: "redirect",
    });

    expect(decoded.id).toBe("error");
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
    const result = Schema.decodeUnknownEither(LogSource)({
      id: "console",
      path: "/var/log/app.log",
      stream: "stderr",
      strategy: "follow",
    });

    expect(Either.isLeft(result)).toBe(true);
  });

  test("rejects an unknown strategy", () => {
    const result = Schema.decodeUnknownEither(LogSource)({
      id: "app",
      path: "/var/log/app.log",
      stream: "stderr",
      strategy: "sidecar",
    });

    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("LogSourceInput", () => {
  test("defaults id to the path basename, stream to stderr, and always follows", () => {
    const decoded = Schema.decodeUnknownSync(LogSourceInput)({
      path: "/var/log/apache2/error.log",
    });

    expect(decoded.id).toBe("error.log");
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

    expect(decoded.id).toBe("app");
    expect(decoded.label).toBe("Application log");
    expect(decoded.stream).toBe("stdout");
    expect(decoded.strategy).toBe("follow");
  });

  test("rejects a user source whose path basename is the reserved console id", () => {
    const result = Schema.decodeUnknownEither(LogSourceInput)({
      path: "/var/log/console",
    });

    expect(Either.isLeft(result)).toBe(true);
  });
});
