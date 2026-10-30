import { expect, test } from "bun:test";
import { HealthcheckInput, ServiceConfig } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

test.each([
  false,
  "test -f ready",
  ["ready", "$HOME"],
  { test: ["CMD", "ready"], timeout: "250ms", retries: "0" },
  { disable: true, user: "root", target: "host", interval: "0s" },
])("readiness uses shared normalization with a strict encode roundtrip: %j", (readiness) => {
  // Given
  const input = { readiness, healthcheck: ["native"] };
  // When
  const decoded = Schema.decodeUnknownSync(ServiceConfig)(input, { onExcessProperty: "error" });
  const roundtrip = Schema.decodeUnknownSync(ServiceConfig)(Schema.encodeSync(ServiceConfig)(decoded), {
    onExcessProperty: "error",
  });
  // Then
  expect(decoded.readiness).toEqual(Schema.decodeUnknownSync(HealthcheckInput)(readiness));
  expect(roundtrip).toEqual(decoded);
  expect(decoded.healthcheck).toEqual({ kind: "command", command: ["native"] });
});

test.each([
  { timeoutSeconds: 0 },
  { timeout: "0s" },
  { intervalSeconds: -1 },
  { startPeriodSeconds: -1 },
  { retries: -1 },
  { retries: 0.5 },
  { disable: true, timeout: "0s" },
  { kind: "none", timeoutSeconds: -1 },
  { kind: "none", timeout: "0s" },
  { kind: "none", intervalSeconds: -1 },
  { disable: true, test: " " },
  { kind: "none", command: [""] },
  " ",
  [""],
])("rejects malformed commands and timing before disabling: %j", (readiness) => {
  // Given / When
  const result = Schema.decodeUnknownResult(ServiceConfig)({ readiness }, { onExcessProperty: "error" });
  // Then
  expect(Result.isFailure(result)).toBe(true);
});
