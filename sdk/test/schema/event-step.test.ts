import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import { ToolingStepConditionError, ToolingStepSelectorUnavailableError } from "@lando/sdk/errors";
import { AppLifecycleEventName, EventStep, LandofileEvents, PortablePath } from "@lando/sdk/schema";
import * as schemas from "@lando/sdk/schema";

const decodeOptions = [undefined, { onExcessProperty: "error" }] as const;

const acceptedSteps = [
  "echo string",
  { cmd: "echo object", if: "{{ event.ready }}", silent: true },
  { task: "prepare", vars: { MODE: "fast", RETRIES: 2, ENABLED: true }, if: true, silent: false },
  {
    command: "app:info",
    flags: { format: "json" },
    args: { service: "appserver", depth: 2, ready: true },
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
  test("decodes every structured authoring form under default and strict options", () => {
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
  test("accepts the tooling working-directory grammar on direct event commands", () => {
    // Given
    const input = { cmd: "pwd", service: ":host", dir: "/workspace" };

    // When
    const decoded = Schema.decodeUnknownSync(EventStep)(input);

    // Then
    expect(decoded).toEqual({ ...input, dir: PortablePath.make(input.dir) });
  });

  test("rejects positional arrays for canonical command arguments", () => {
    // Given
    const input = { command: "app:info", args: ["appserver"] };

    // When
    const decoded = Schema.decodeUnknownEither(EventStep)(input, { onExcessProperty: "error" });

    // Then
    expect(Either.isLeft(decoded)).toBe(true);
  });
});

describe("LandofileEvents", () => {
  test("publishes all twelve lifecycle names in canonical order", () => {
    // Given
    const expected: Array<(typeof AppLifecycleEventName.literals)[number]> = [
      "pre-init",
      "post-init",
      "pre-start",
      "post-start",
      "pre-stop",
      "post-stop",
      "pre-restart",
      "post-restart",
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

  test("preserves tooling keys including namespaced ids under strict decoding", () => {
    // Given
    const input = { "pre-build": ["echo x"], "post-docs:build": [{ cmd: "echo y", service: ":host" }] };
    // When
    const result = Schema.decodeUnknownEither(LandofileEvents)(input, { onExcessProperty: "error" });
    // Then
    expect(result).toEqual(Either.right(input));
    if (Either.isRight(result)) {
      const indexed: Record<string, readonly EventStep[] | undefined> = result.right;
      expect(indexed["post-docs:build"]).toEqual(input["post-docs:build"]);
    }
  });

  test("preserves malformed names for semantic validation", () => {
    // Given
    const input = { serve: ["echo x"] };
    // When
    const result = Schema.decodeUnknownEither(LandofileEvents)(input, { onExcessProperty: "error" });
    // Then
    expect(result).toEqual(Either.right(input));
  });

  test("decodes all twelve named event keys", () => {
    // Given
    const input = Object.fromEntries(
      [
        "pre-init",
        "post-init",
        "pre-start",
        "post-start",
        "pre-stop",
        "post-stop",
        "pre-restart",
        "post-restart",
        "pre-rebuild",
        "post-rebuild",
        "pre-destroy",
        "post-destroy",
      ].map((name) => [name, ["echo x"]]),
    );
    // When
    const result = Schema.decodeUnknownEither(LandofileEvents)(input, { onExcessProperty: "error" });
    // Then
    expect(result).toEqual(Either.right(input));
  });

  test("accepts only prefixed Landofile event names", () => {
    // Given / When / Then
    expect(schemas).toHaveProperty("LandofileEventName");
    for (const name of ["pre-start", "pre-build", "post-docs:build"]) {
      expect(Either.isRight(Schema.decodeUnknownEither(schemas.LandofileEventName)(name))).toBe(true);
    }
    for (const name of ["serve", "build"]) {
      expect(Either.isLeft(Schema.decodeUnknownEither(schemas.LandofileEventName)(name))).toBe(true);
    }
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
