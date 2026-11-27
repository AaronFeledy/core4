import { expect, test } from "bun:test";
import type { ToolingError } from "@lando/sdk/app";
import * as errors from "@lando/sdk/errors";
import { Result, Schema } from "effect";

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
  const result = Schema.decodeUnknownResult(errors.LandofileEventLifecycleReentryError)(input);
  // Then
  expect(Result.isFailure(result)).toBe(true);
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

test("a step refused before it started carries located issues and no exit code across the wire", () => {
  // Given a step Lando refused while resolving a value it reads
  const refused = new errors.LandofileEventStepFailedError({
    message: "Event pre-start step 1 did not run: services.web.url is not available during pre-start.",
    event: "pre-start",
    index: 0,
    kind: "cmd",
    outputTail: "",
    issues: [
      {
        rule: "landofile.tooling",
        reason: "event-phase",
        path: ["events", "pre-start", 0, "cmd"],
        message: "services.web.url is not available during pre-start.",
      },
    ],
    omittedIssueCount: 0,
    remediation: "Read the URL in a post-start step.",
  });
  // When
  const decoded = Schema.decodeUnknownSync(errors.LandofileEventStepFailedError)(
    Schema.encodeSync(errors.LandofileEventStepFailedError)(refused),
  );
  // Then
  expect(decoded).toEqual(refused);
  expect(decoded).not.toHaveProperty("exitCode");
});
