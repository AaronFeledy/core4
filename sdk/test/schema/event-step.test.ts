import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { ToolingStepConditionError, ToolingStepSelectorUnavailableError } from "@lando/sdk/errors";
import { AppLifecycleEventName, EventStep, LandofileEvents } from "@lando/sdk/schema";

const decodeOptions = [undefined, { onExcessProperty: "error" }] as const;

const acceptedSteps = [
  "echo string",
  { cmd: "echo object", if: "{{ event.ready }}", silent: true },
  { task: "prepare", vars: { MODE: "fast", RETRIES: 2, ENABLED: true }, if: true, silent: false },
  {
    command: "app:info",
    flags: { format: "json" },
    args: ["appserver"],
    raw: ["--verbose"],
    ignoreError: true,
    if: false,
    silent: true,
  },
  { defer: "php artisan down", service: "appserver", if: true, silent: true },
  { defer: true, task: "cleanup", vars: { MODE: "safe" } },
  { defer: true, command: "app:info", raw: ["--json"], ignoreError: true },
  { for: ["one", "two"], cmd: "echo {{ item }}" },
  { for: { var: "TARGETS" }, task: "build" },
  { for: { matrix: { PHP: ["8.3", "8.4"], DEBUG: [true, false] } }, command: "app:info" },
  { for: { sources: true }, cmd: "echo {{ item }}" },
  { for: { generates: true }, defer: "rm {{ item }}" },
] as const;

describe("EventStep", () => {
  test("decodes every Wave 3 authoring form under default and strict options", () => {
    // Given / When / Then
    for (const options of decodeOptions) {
      for (const step of acceptedSteps) {
        expect(Either.isRight(Schema.decodeUnknownEither(EventStep)(step, options))).toBe(true);
      }
    }
  });

  test("rejects overlapping leaf discriminators under default and strict options", () => {
    // Given
    const overlapping = [
      { cmd: "echo bad", task: "also-bad" },
      { task: "bad", command: "app:info" },
      { command: "app:info", cmd: "echo bad" },
      { defer: "echo later", task: "bad" },
      { defer: true, cmd: "echo later", task: "bad" },
      { for: ["one"], cmd: "echo", command: "app:info" },
    ] as const;

    // When / Then
    for (const options of decodeOptions) {
      for (const step of overlapping) {
        expect(Either.isLeft(Schema.decodeUnknownEither(EventStep)(step, options))).toBe(true);
      }
    }
  });

  test("rejects selector overlap and excess properties", () => {
    // Given
    const invalid = [
      { for: { var: "TARGETS", sources: true }, cmd: "echo" },
      { for: { matrix: { PHP: ["8.4"] }, generates: true }, cmd: "echo" },
      { for: { sources: false }, cmd: "echo" },
      { for: { generates: "dist/**" }, cmd: "echo" },
      { cmd: "echo", unknown: true },
    ] as const;

    // When / Then
    for (const step of invalid) {
      expect(Either.isLeft(Schema.decodeUnknownEither(EventStep)(step, { onExcessProperty: "error" }))).toBe(
        true,
      );
    }
  });
});

describe("LandofileEvents", () => {
  test("publishes all ten lifecycle names in canonical order", () => {
    // Given
    const expected: Array<(typeof AppLifecycleEventName.literals)[number]> = [
      "pre-init",
      "post-init",
      "pre-start",
      "post-start",
      "pre-stop",
      "post-stop",
      "pre-rebuild",
      "post-rebuild",
      "pre-destroy",
      "post-destroy",
    ];

    // When
    const names = AppLifecycleEventName.literals;
    const eventKeys = Object.keys(LandofileEvents.fields);

    // Then
    expect([...names]).toEqual(expected);
    expect(eventKeys).toEqual(expected);
  });
});

describe("event tooling errors", () => {
  test("exports typed condition and selector failures", () => {
    // Given
    const condition = new ToolingStepConditionError({
      message: "The event condition could not be evaluated.",
      condition: "{{ event.ready }}",
      remediation: "Fix the condition expression.",
    });
    const selector = new ToolingStepSelectorUnavailableError({
      message: "The sources selector is unavailable for root events.",
      selector: "sources",
      remediation: "Use an explicit list or task variable.",
    });

    // When / Then
    expect(condition._tag).toBe("ToolingStepConditionError");
    expect(selector._tag).toBe("ToolingStepSelectorUnavailableError");
  });
});
