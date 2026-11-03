import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ScheduleConfig, ServiceConfig } from "@lando/sdk/schema";

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

  test("Given a duplicate job name, when decoding ScheduleConfig, then it fails", () => {
    const result = strictDecode(ScheduleConfig, [job(), job({ run: "echo again" })]);
    expect(result._tag).toBe("Failure");
  });

  test("Given an unknown job key, when strictly decoding ScheduleConfig, then it fails", () => {
    const result = strictDecode(ScheduleConfig, [job({ extra: true })]);
    expect(result._tag).toBe("Failure");
  });

  test("Given @every 1s and named schedules, when decoding ScheduleConfig, then it succeeds", () => {
    for (const every of ["@hourly", "@daily", "@every 1s", "@every 1h30m", "0 0 * * *"]) {
      expect(strictDecode(ScheduleConfig, [job({ name: "n", every })])._tag).toBe("Success");
    }
  });
});
