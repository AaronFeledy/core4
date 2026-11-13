import { describe, expect, test } from "bun:test";
import { ScheduleConfig, ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";

const strictDecode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);

const job = (overrides: Record<string, unknown> = {}) => ({
  name: "tick",
  every: "@hourly",
  run: "true",
  ...overrides,
});

describe("schedule Landofile schema", () => {
  test("Given a valid job, when strictly decoding ServiceConfig, then it succeeds", () => {
    const result = strictDecode(ServiceConfig, {
      type: "php:8.3",
      schedule: [job({ every: "*/5 * * * *", run: ["php", "cron.php"] })],
    });
    expect(result._tag).toBe("Success");
  });

  test("Given a bad cron expression, when decoding ScheduleConfig, then it fails", () => {
    const result = strictDecode(ScheduleConfig, [job({ every: "not a cron" })]);
    expect(result._tag).toBe("Failure");
  });

  test("Given a raw cron expression that is not exactly five fields, when decoding ScheduleConfig, then it fails", () => {
    for (const every of ["0 0 * * * *", "0 0 0 * * * *", "0 0 * *"]) {
      const result = strictDecode(ScheduleConfig, [job({ every })]);
      expect(result._tag, every).toBe("Failure");
      expect(JSON.stringify(result), every).toContain("5-field cron expression");
    }
  });

  test("Given a duplicate job name, when decoding ScheduleConfig, then it fails", () => {
    const result = strictDecode(ScheduleConfig, [job(), job({ run: "echo again" })]);
    expect(result._tag).toBe("Failure");
  });

  test("Given an unknown job key, when strictly decoding ScheduleConfig, then it fails", () => {
    const result = strictDecode(ScheduleConfig, [job({ extra: true })]);
    expect(result._tag).toBe("Failure");
  });

  test("Given @every 1s and named schedules, when decoding ScheduleConfig, then it succeeds", () => {
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

  test("Given an @every duration supercronic cannot express, when decoding ScheduleConfig, then it fails", () => {
    expect(strictDecode(ScheduleConfig, [job({ every: "@every 1h30m" })])._tag).toBe("Failure");
  });

  test("Given an @every duration with a sub-second part, when decoding ScheduleConfig, then it fails", () => {
    for (const every of ["@every 1s1ns", "@every 1500ms", "@every 500us"]) {
      const result = strictDecode(ScheduleConfig, [job({ every })]);
      expect(result._tag, every).toBe("Failure");
    }
  });

  test("Given @every steps that do not divide the clock field, when decoding ScheduleConfig, then it fails with a 5-field cron suggestion", () => {
    for (const every of ["@every 7s", "@every 7m", "@every 7h", "@every 5h", "@every 1500ms"]) {
      const result = strictDecode(ScheduleConfig, [job({ every })]);
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).toContain("5-field cron expression");
    }
  });
});
