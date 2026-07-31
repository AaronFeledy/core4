import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { PluginDoctorReport, getJsonSchema } from "@lando/sdk/schema";

const maximumReport: typeof PluginDoctorReport.Encoded = {
  name: "n".repeat(128),
  status: "warn",
  severity: "warn",
  runtimeStatus: "s".repeat(2_000),
  runtime: { running: true, version: "v".repeat(256) },
  context: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key-${index}`, "c".repeat(500)])),
  solutions: Array.from({ length: 16 }, () => ({
    kind: "manual" as const,
    description: "d".repeat(2_000),
    command: "x".repeat(2_000),
  })),
};

const overBoundReports: ReadonlyArray<{ readonly boundary: string; readonly report: unknown }> = [
  { boundary: "name length", report: { ...maximumReport, name: "n".repeat(129) } },
  { boundary: "message length", report: { ...maximumReport, runtimeStatus: "s".repeat(2_001) } },
  {
    boundary: "runtime version length",
    report: { ...maximumReport, runtime: { running: true, version: "v".repeat(257) } },
  },
  {
    boundary: "context key length",
    report: { ...maximumReport, context: { ["k".repeat(129)]: "value" } },
  },
  {
    boundary: "context value length",
    report: { ...maximumReport, context: { evidence: "c".repeat(2_001) } },
  },
  {
    boundary: "context entry count",
    report: {
      ...maximumReport,
      context: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, "value"])),
    },
  },
  {
    boundary: "context total value length",
    report: {
      ...maximumReport,
      context: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`key-${index}`, "c".repeat(2_000)]),
      ),
    },
  },
  {
    boundary: "solution count",
    report: {
      ...maximumReport,
      solutions: Array.from({ length: 17 }, () => ({ kind: "manual", description: "fix it" })),
    },
  },
  {
    boundary: "solution description length",
    report: {
      ...maximumReport,
      solutions: [{ kind: "manual", description: "d".repeat(2_001) }],
    },
  },
  {
    boundary: "solution command length",
    report: {
      ...maximumReport,
      solutions: [{ kind: "manual", description: "fix it", command: "x".repeat(2_001) }],
    },
  },
  {
    boundary: "strict object shape",
    report: { ...maximumReport, unexpected: true },
  },
];

describe("PluginDoctorReport", () => {
  test("accepts every documented maximum", () => {
    const decoded = Schema.decodeUnknownEither(PluginDoctorReport, { onExcessProperty: "error" })(
      maximumReport,
    );

    expect(Either.isRight(decoded)).toBe(true);
  });

  for (const { boundary, report } of overBoundReports) {
    test(`rejects a report over the ${boundary} boundary`, () => {
      const decoded = Schema.decodeUnknownEither(PluginDoctorReport, { onExcessProperty: "error" })(report);

      expect(Either.isLeft(decoded)).toBe(true);
    });
  }

  test("publishes the context entry bound in JSON Schema", () => {
    const jsonSchema = getJsonSchema("PluginDoctorReport");

    expect(jsonSchema).toHaveProperty("properties.context.maxProperties", 32);
  });
});
