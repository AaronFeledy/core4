import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  DoctorSeveritySchema,
  DoctorStatusSchema,
  failCheck,
  passCheckNamed,
  warnCheck,
} from "../../src/cli/commands/doctor-check-builders";

describe("doctor check builders", () => {
  const input = { name: "example", context: { ready: "false" }, solutions: [] } as const;

  test("preserves key order when recovery is omitted", () => {
    const check = warnCheck(input);
    expect(Object.keys(check)).toEqual(["name", "status", "severity", "context", "solutions"]);
  });

  test("preserves key order when recovery is supplied", () => {
    const check = warnCheck({ ...input, recovery: "manual" });
    expect(Object.keys(check)).toEqual(["name", "status", "severity", "recovery", "context", "solutions"]);
  });

  test("omits recovery from failures when not supplied", () => {
    const check = failCheck(input);
    expect("recovery" in check).toBe(false);
  });

  test.each([
    [() => warnCheck(input), "warn", "warn"],
    [() => failCheck(input), "fail", "error"],
    [() => passCheckNamed(input), "pass", "info"],
  ] as const)("maps builder %p to status %s and severity %s", (build, status, severity) => {
    const check = build();
    expect(check.status).toBe(status);
    expect(check.severity).toBe(severity);
  });

  test("preserves failure remediation when supplied", () => {
    const solutions = [{ kind: "manual", description: "Repair", command: "lando setup" }] as const;
    const check = failCheck({ ...input, solutions, recovery: "automatic" });
    expect(check).toEqual({
      name: "example",
      status: "fail",
      severity: "error",
      recovery: "automatic",
      context: input.context,
      solutions,
    });
  });

  test.each(["pass", "warn", "fail"])("accepts status %s", (status) => {
    expect(Schema.is(DoctorStatusSchema)(status)).toBe(true);
  });

  test.each(["warning", "info", "error", "PASS", "", null, undefined, 0, {}])(
    "rejects non-status %p",
    (status) => {
      expect(Schema.is(DoctorStatusSchema)(status)).toBe(false);
    },
  );

  test("preserves the captured pre-refactor status JSON Schema", () => {
    const document = Schema.toJsonSchemaDocument(DoctorStatusSchema);
    expect(document).toEqual({
      dialect: "draft-2020-12",
      schema: { type: "string", enum: ["pass", "warn", "fail"] },
      definitions: {},
    });
  });

  test("preserves severity schema choices", () => {
    const document = Schema.toJsonSchemaDocument(DoctorSeveritySchema);
    expect(document.schema).toEqual({ type: "string", enum: ["info", "warn", "error"] });
  });
});
