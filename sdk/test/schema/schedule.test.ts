import { describe, expect, test } from "bun:test";
import { ScheduleConfig, ServiceConfig, validationIssuesFromSchemaIssue } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const strictDecode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);

const job = (overrides: Record<string, unknown> = {}) => ({
  name: "tick",
  every: "@hourly",
  run: "true",
  ...overrides,
});

describe("schedule Landofile schema", () => {
  test("accepts scheduled argv commands on a service", () => {
    const result = strictDecode(ServiceConfig, {
      type: "php:8.3",
      schedule: [job({ every: "*/5 * * * *", run: ["php", "cron.php"] })],
    });
    expect(result._tag).toBe("Success");
  });

  test("rejects invalid cron expressions", () => {
    const result = strictDecode(ScheduleConfig, [job({ every: "not a cron" })]);
    expect(result._tag).toBe("Failure");
  });

  test("rejects cron expressions without exactly five fields at the cadence path", () => {
    for (const every of ["0 0 * * * *", "0 0 0 * * * *", "0 0 * *"]) {
      const result = strictDecode(ScheduleConfig, [job({ every })]);
      expect(result._tag, every).toBe("Failure");
      if (Result.isFailure(result)) {
        expect(
          validationIssuesFromSchemaIssue(result.failure.issue).map(({ path }) => path),
          every,
        ).toEqual([[0, "every"]]);
      }
    }
  });

  test("rejects duplicate job names", () => {
    const result = strictDecode(ScheduleConfig, [job(), job({ run: "echo again" })]);
    expect(result._tag).toBe("Failure");
  });

  test("rejects unknown job keys", () => {
    const result = strictDecode(ScheduleConfig, [job({ extra: true })]);
    expect(result._tag).toBe("Failure");
  });

  test("accepts named schedules, clock-aligned durations, and five-field cron", () => {
    for (const every of [
      "@hourly",
      "@daily",
      "@every 1s",
      "@every 10s",
      "@every 5m",
      "@every 15m",
      "@every 1h",
      "@every 2h",
      "@every 12h",
      "@every 24h",
      "0 0 * * *",
      "0 0 31 2 *",
    ]) {
      expect(strictDecode(ScheduleConfig, [job({ name: "n", every })])._tag, every).toBe("Success");
    }
  });

  test("rejects durations that cannot map to a clock step", () => {
    expect(strictDecode(ScheduleConfig, [job({ every: "@every 1h30m" })])._tag).toBe("Failure");
  });

  test("rejects durations with a sub-second remainder", () => {
    for (const every of ["@every 1s1ns", "@every 1500ms", "@every 500us"]) {
      const result = strictDecode(ScheduleConfig, [job({ every })]);
      expect(result._tag, every).toBe("Failure");
    }
  });

  test("rejects non-dividing clock steps at the cadence path", () => {
    for (const every of ["@every 7s", "@every 7m", "@every 7h", "@every 5h", "@every 1500ms"]) {
      const result = strictDecode(ScheduleConfig, [job({ every })]);
      expect(result._tag, every).toBe("Failure");
      if (Result.isFailure(result)) {
        expect(
          validationIssuesFromSchemaIssue(result.failure.issue).map(({ path }) => path),
          every,
        ).toEqual([[0, "every"]]);
      }
    }
  });
});
