import { expect, test } from "bun:test";
import { Either, Schema } from "effect";

import type { ToolingError } from "@lando/sdk/app";
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

test("tooling failures carry event runtime errors so bracket failures keep their identity", () => {
  // Given a top-level tooling run that brackets pre/post task events
  const stepFailure = new errors.LandofileEventStepFailedError({
    message: "Event post-build step 1 failed.",
    event: "post-build",
    index: 0,
    kind: "cmd",
    exitCode: 5,
    outputTail: "boom",
    remediation: "Fix post-build step 1, then rerun the lifecycle command.",
  });
  const reentry = new errors.LandofileEventLifecycleReentryError({
    message: "Command app:build reentered event pre-build.",
    event: "pre-build",
    command: "app:build",
    chain: ["pre-build", "app:build", "pre-build"],
    remediation: "Remove the lifecycle command cycle.",
  });
  const depth = new errors.LandofileEventInvocationDepthError({
    message: "Event pre-build exceeded the invocation depth limit.",
    event: "pre-build",
    chain: ["pre-build"],
    depth: 17,
    limit: 16,
    remediation: "Reduce nested event commands.",
  });
  // When the failures are surfaced through the published tooling error channel
  const surfaced: ReadonlyArray<ToolingError> = [stepFailure, reentry, depth];
  // Then each keeps its own tag rather than collapsing into a generic exec failure
  expect(surfaced.map((error) => error._tag)).toEqual([
    "LandofileEventStepFailedError",
    "LandofileEventLifecycleReentryError",
    "LandofileEventInvocationDepthError",
  ]);
});
