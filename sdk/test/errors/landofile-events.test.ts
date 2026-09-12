import { expect, test } from "bun:test";
import { Either, Schema } from "effect";

import * as errors from "@lando/sdk/errors";

test("depth failures expose the invocation chain and limit", () => {
  // Given
  expect(errors).toHaveProperty("LandofileEventInvocationDepthError");
  const input = {
    message: "Depth exceeded",
    event: "pre-build",
    chain: ["pre-start", "pre-build"],
    depth: 2,
    limit: 1,
    remediation: "Reduce nesting.",
  };
  // When
  const error = new errors.LandofileEventInvocationDepthError(input);
  // Then
  expect(error._tag).toBe("LandofileEventInvocationDepthError");
  expect(
    Schema.decodeUnknownSync(errors.LandofileEventInvocationDepthError)(
      Schema.encodeSync(errors.LandofileEventInvocationDepthError)(error),
    ),
  ).toEqual(error);
});

test("lifecycle reentry failures preserve their required invocation chain", () => {
  // Given
  const input = {
    message: "Cycle",
    event: "pre-start",
    command: "app:start",
    chain: ["pre-start", "pre-start"],
    remediation: "Remove the cycle.",
  };
  // When
  const error = new errors.LandofileEventLifecycleReentryError(input);
  const wire = Schema.encodeSync(errors.LandofileEventLifecycleReentryError)(error);
  // Then
  expect(Schema.decodeUnknownSync(errors.LandofileEventLifecycleReentryError)(wire).chain).toEqual(
    input.chain,
  );
});

test("lifecycle reentry decoding rejects a missing invocation chain", () => {
  // Given
  const input = {
    _tag: "LandofileEventLifecycleReentryError",
    message: "Cycle",
    event: "pre-start",
    command: "app:start",
    remediation: "Remove the cycle.",
  };
  // When
  const result = Schema.decodeUnknownEither(errors.LandofileEventLifecycleReentryError)(input);
  // Then
  expect(Either.isLeft(result)).toBe(true);
});
