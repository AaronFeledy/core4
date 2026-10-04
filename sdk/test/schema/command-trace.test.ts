import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import {
  CommandTrace,
  CommandTraceSpan,
  GlobalConfig,
  GlobalConfigView,
  JSON_SCHEMA_NAMES,
  TracingConfig,
} from "@lando/sdk/schema";

const rootSpan = {
  id: "root",
  name: "lando meta:config",
  startOffsetMs: 0,
  durationMs: 12.5,
  status: "ok" as const,
  attributes: { "lando.command.id": "meta:config", "lando.invocation.id": "inv-1" },
};

const childSpan = {
  id: "init",
  name: "CommandLifecycle.init",
  parent: "root",
  startOffsetMs: 0.5,
  durationMs: 4,
  status: "ok" as const,
  attributes: {},
};

describe("CommandTraceSpan", () => {
  test("round-trips a root span and a child span", () => {
    for (const wire of [rootSpan, childSpan]) {
      const decoded = Schema.decodeUnknownSync(CommandTraceSpan)(wire);
      expect(Schema.encodeSync(CommandTraceSpan)(decoded)).toEqual(wire);
    }
  });

  test("accepts every status literal", () => {
    for (const status of ["ok", "error", "interrupted"] as const) {
      const wire = { ...rootSpan, status };
      expect(Schema.decodeUnknownSync(CommandTraceSpan)(wire).status).toBe(status);
    }
  });

  test("rejects a negative duration", () => {
    expect(() => Schema.decodeUnknownSync(CommandTraceSpan)({ ...rootSpan, durationMs: -1 })).toThrow(
      Schema.SchemaError,
    );
  });

  test("rejects a non-scalar attribute value", () => {
    expect(() =>
      Schema.decodeUnknownSync(CommandTraceSpan)({
        ...rootSpan,
        attributes: { nested: { a: 1 } },
      }),
    ).toThrow(Schema.SchemaError);
  });
});

describe("CommandTrace", () => {
  test("round-trips a multi-span tree with droppedSpans", () => {
    const wire = {
      totalDurationMs: 12.5,
      spans: [rootSpan, childSpan],
      droppedSpans: 0,
    };
    const decoded = Schema.decodeUnknownSync(CommandTrace)(wire);
    expect(decoded.spans).toHaveLength(2);
    expect(decoded.droppedSpans).toBe(0);
    expect(Schema.encodeSync(CommandTrace)(decoded)).toEqual(wire);
  });

  test("rejects a fractional droppedSpans count", () => {
    const result = Schema.decodeUnknownResult(CommandTrace)({
      totalDurationMs: 1,
      spans: [rootSpan],
      droppedSpans: 1.5,
    });
    expect(Result.isFailure(result)).toBe(true);
  });

  test("rejects a negative totalDurationMs", () => {
    const result = Schema.decodeUnknownResult(CommandTrace)({
      totalDurationMs: -0.1,
      spans: [],
      droppedSpans: 0,
    });
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("TracingConfig", () => {
  test("round-trips OTLP endpoint and headers", () => {
    const wire = {
      otlp: {
        endpoint: "http://localhost:4318",
        headers: { Authorization: "Bearer token" },
      },
    };
    const decoded = Schema.decodeUnknownSync(TracingConfig)(wire);
    expect(Schema.encodeSync(TracingConfig)(decoded)).toEqual(wire);
  });

  test("accepts an empty object", () => {
    expect(Schema.decodeUnknownSync(TracingConfig)({})).toEqual({});
  });

  test("participates in the public schema registry", () => {
    expect(JSON_SCHEMA_NAMES).toContain("CommandTrace");
    expect(JSON_SCHEMA_NAMES).toContain("CommandTraceSpan");
    expect(JSON_SCHEMA_NAMES).toContain("TracingConfig");
  });
});

describe("GlobalConfig.tracing", () => {
  test("decodes optional tracing into GlobalConfig and GlobalConfigView", () => {
    const wire = {
      tracing: {
        otlp: { endpoint: "https://otlp.example.com", headers: { "x-tenant": "demo" } },
      },
    };
    const decoded = Schema.decodeUnknownSync(GlobalConfig)(wire);
    expect(decoded.tracing?.otlp?.endpoint).toBe("https://otlp.example.com");
    const view = Schema.encodeSync(GlobalConfigView)(decoded);
    expect(view).toMatchObject(wire);
    expect(Schema.decodeUnknownSync(GlobalConfigView)(view).tracing).toEqual(decoded.tracing);
  });
});
