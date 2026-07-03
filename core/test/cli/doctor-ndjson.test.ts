import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { SecretNotFoundError } from "@lando/core/errors";
import { SecretStore } from "@lando/core/services";
import { StreamFrame } from "@lando/sdk/schema";

import { type DoctorNdjsonCheck, renderDoctorChecksAsNdjson } from "../../src/cli/commands/doctor-ndjson.ts";
import { RedactionService, RedactionServiceLive } from "../../src/redaction/service.ts";

interface LeakyCheck extends DoctorNdjsonCheck {
  readonly detail: string;
}

const checkEventPayload = (check: LeakyCheck): Record<string, unknown> => ({
  _tag: "doctor.check",
  name: "leaky-check",
  status: check.status,
  severity: "error",
  context: { detail: check.detail },
});

const secretStoreLayer = (values: Record<string, string>) =>
  Layer.succeed(SecretStore, {
    id: "test",
    get: (secret: string) => {
      const value = values[secret];
      return value === undefined
        ? Effect.fail(new SecretNotFoundError({ secret, message: `missing ${secret}` }))
        : Effect.succeed(value);
    },
    has: (secret: string) => Effect.succeed(values[secret] !== undefined),
    list: Effect.succeed(Object.keys(values)),
  });

const secretsRedactor = (values: Record<string, string>) =>
  Effect.runPromise(
    Effect.flatMap(RedactionService, (service) => service.forProfile("secrets")).pipe(
      Effect.provide(RedactionServiceLive),
      Effect.provide(secretStoreLayer(values)),
    ),
  );

const eventLines = (ndjson: string): ReadonlyArray<StreamFrame> =>
  ndjson
    .trimEnd()
    .split("\n")
    .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)))
    .filter((frame) => frame._tag === "event");

describe("renderDoctorChecksAsNdjson stream-frame seam", () => {
  test("default (no redactor) event lines are byte-identical to the central StreamFrame encoding", () => {
    const check: LeakyCheck = { status: "fail", detail: "socket=/tmp/run.sock" };
    const ndjson = renderDoctorChecksAsNdjson<LeakyCheck>({
      checks: [check],
      now: new Date("1970-01-01T00:00:00.000Z"),
      checkEventPayload,
    });

    const firstLine = ndjson.split("\n")[0];
    const expected = JSON.stringify(
      Schema.encodeSync(StreamFrame)({
        _tag: "event",
        event: "doctor.check",
        payload: checkEventPayload(check),
      }),
    );
    expect(firstLine).toBe(expected);
  });

  test("an injected secrets redactor masks a registered secret in a doctor check result", async () => {
    const secret = "us383-doctor-secret-value";
    const redactor = await secretsRedactor({ TOKEN: secret });
    const check: LeakyCheck = { status: "fail", detail: `leaked ${secret}` };

    const ndjson = renderDoctorChecksAsNdjson<LeakyCheck>({
      checks: [check],
      now: new Date("1970-01-01T00:00:00.000Z"),
      checkEventPayload,
      redactor,
    });

    expect(ndjson).not.toContain(secret);
    expect(ndjson).toContain("[redacted]");

    const [event] = eventLines(ndjson);
    expect(event?._tag).toBe("event");
    const payload = (event as Extract<StreamFrame, { readonly _tag: "event" }>).payload as {
      readonly context?: { readonly detail?: string };
    };
    expect(payload.context?.detail).toContain("[redacted]");
    expect(payload.context?.detail).not.toContain(secret);
  });
});
