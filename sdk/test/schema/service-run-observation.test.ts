import { describe, expect, test } from "bun:test";

import { ServiceRunObservation } from "@lando/sdk/schema";
import { Schema } from "effect";

const isObservation = Schema.is(ServiceRunObservation);

describe("ServiceRunObservation", () => {
  test("rejects the contradictory combinations the type already forbids", () => {
    expect(isObservation({ status: "exited", health: "healthy" })).toBe(false);
    expect(isObservation({ status: "created", exitCode: 0 })).toBe(false);
    expect(isObservation({ status: "running", exitCode: 0 })).toBe(false);
    expect(isObservation({ status: "stopped" })).toBe(false);
    expect(isObservation({ status: "running", health: "starting" })).toBe(true);
    expect(isObservation({ status: "dead", exitCode: 1 })).toBe(false);
  });
});
