import { describe, expect, test } from "bun:test";

import { ParseResult, Schema } from "effect";

import { CommandResultEnvelope, CommandResultFormat, CommandWarning, StreamFrame } from "@lando/sdk/schema";

const ISO_TIMESTAMP = "2026-06-14T00:00:00.000Z";

const deprecationUse = {
  kind: "config-key" as const,
  id: "services.web.legacy",
  notice: {
    severity: "warn" as const,
    note: "Use the new key instead.",
    since: "4.2.0",
    removeIn: "5.0.0",
  },
  timestamp: ISO_TIMESTAMP,
};

describe("CommandResultFormat", () => {
  test("round-trips every literal member", () => {
    for (const value of ["text", "json", "table", "yaml", "ndjson"] as const) {
      const encoded = Schema.encodeSync(CommandResultFormat)(value);
      expect(encoded).toBe(value);
      expect(Schema.decodeUnknownSync(CommandResultFormat)(encoded)).toBe(value);
    }
  });

  test("rejects an unknown format", () => {
    expect(() => Schema.decodeUnknownSync(CommandResultFormat)("xml")).toThrow(ParseResult.ParseError);
  });
});

describe("CommandWarning", () => {
  test("round-trips with and without remediation", () => {
    const withRemediation = { code: "deprecated", message: "stop", remediation: "use --new" };
    const encoded = Schema.encodeSync(CommandWarning)(withRemediation);
    expect(encoded).toEqual(withRemediation);
    expect(Schema.decodeUnknownSync(CommandWarning)(encoded)).toEqual(withRemediation);

    const minimal = { code: "info", message: "noted" };
    const encodedMinimal = Schema.encodeSync(CommandWarning)(minimal);
    expect(encodedMinimal).toEqual(minimal);
    expect(Schema.decodeUnknownSync(CommandWarning)(encodedMinimal).remediation).toBeUndefined();
  });

  test("rejects a missing message", () => {
    expect(() => Schema.decodeUnknownSync(CommandWarning)({ code: "x" })).toThrow(ParseResult.ParseError);
  });
});

describe("CommandResultEnvelope", () => {
  test("round-trips a successful result envelope", () => {
    const wire = {
      apiVersion: "v4" as const,
      command: "app:info",
      ok: true,
      result: { name: "my-app", services: ["web", "db"] },
      warnings: [{ code: "info", message: "fyi" }],
      deprecations: [deprecationUse],
    };
    const decoded = Schema.decodeUnknownSync(CommandResultEnvelope)(wire);

    expect(decoded.apiVersion).toBe("v4");
    expect(decoded.command).toBe("app:info");
    expect(decoded.ok).toBe(true);
    expect(decoded.result).toEqual({ name: "my-app", services: ["web", "db"] });
    expect(decoded.error).toBeUndefined();
    expect(decoded.warnings).toHaveLength(1);
    expect(decoded.deprecations).toHaveLength(1);

    expect(Schema.encodeSync(CommandResultEnvelope)(decoded)).toEqual(wire);
  });

  test("round-trips a failing result envelope carrying a tagged error", () => {
    const wire = {
      apiVersion: "v4" as const,
      command: "app:start",
      ok: false,
      error: { _tag: "ProviderUnavailableError", message: "no runtime", remediation: "run lando setup" },
      warnings: [],
      deprecations: [],
    };
    const decoded = Schema.decodeUnknownSync(CommandResultEnvelope)(wire);

    expect(decoded.ok).toBe(false);
    expect(decoded.error?._tag).toBe("ProviderUnavailableError");
    expect(decoded.error?.message).toBe("no runtime");
    expect(decoded.error?.remediation).toBe("run lando setup");
    expect(decoded.result).toBeUndefined();

    expect(Schema.encodeSync(CommandResultEnvelope)(decoded)).toEqual(wire);
  });

  test("decodes a no-payload command as an empty-result envelope", () => {
    const wire = {
      apiVersion: "v4" as const,
      command: "meta:version",
      ok: true,
      result: {},
      warnings: [],
      deprecations: [],
    };
    const decoded = Schema.decodeUnknownSync(CommandResultEnvelope)(wire);
    expect(decoded.result).toEqual({});
    expect(Schema.encodeSync(CommandResultEnvelope)(decoded)).toEqual(wire);
  });

  test("rejects a non-v4 apiVersion", () => {
    expect(() =>
      Schema.decodeUnknownSync(CommandResultEnvelope)({
        apiVersion: "v3",
        command: "app:info",
        ok: true,
        warnings: [],
        deprecations: [],
      }),
    ).toThrow(ParseResult.ParseError);
  });
});

describe("StreamFrame", () => {
  test("round-trips each frame variant", () => {
    const wireFrames = [
      { _tag: "stdout", chunk: "hello\n", service: "web" },
      { _tag: "stderr", chunk: "oops\n" },
      { _tag: "event", event: "app.started", payload: { id: "my-app" } },
      {
        _tag: "result",
        envelope: {
          apiVersion: "v4",
          command: "app:logs",
          ok: true,
          result: {},
          warnings: [],
          deprecations: [],
        },
      },
    ] as const;

    for (const wire of wireFrames) {
      const decoded = Schema.decodeUnknownSync(StreamFrame)(wire);
      expect(decoded._tag).toBe(wire._tag);
      expect(Schema.encodeSync(StreamFrame)(decoded)).toEqual(wire);
    }
  });

  test("decodes a terminal result frame's envelope", () => {
    const decoded = Schema.decodeUnknownSync(StreamFrame)({
      _tag: "result",
      envelope: {
        apiVersion: "v4",
        command: "app:exec",
        ok: false,
        error: { _tag: "ProcessExecError", message: "exit 1" },
        warnings: [],
        deprecations: [],
      },
    });

    expect(decoded._tag).toBe("result");
    if (decoded._tag === "result") {
      expect(decoded.envelope.ok).toBe(false);
      expect(decoded.envelope.error?._tag).toBe("ProcessExecError");
    }
  });

  test("rejects an unknown frame tag", () => {
    expect(() => Schema.decodeUnknownSync(StreamFrame)({ _tag: "exit", code: 0 })).toThrow(
      ParseResult.ParseError,
    );
  });
});
