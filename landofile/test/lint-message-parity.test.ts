import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { violationsFromSchema } from "../src/lint-violations.ts";
import { lintLandofile, mergeLintFindings } from "../src/lint.ts";
import { validationErrorFromCause } from "../src/validation.ts";

const TOOLING_TASK_EXPECTATION =
  "Expected false, disabled, a non-empty command string, or a tooling task object";

test.each([
  [
    "services:\n  api:\n    environment: 5",
    ["services", "api", "environment"],
    "Expected a map or a list of KEY=VALUE strings",
  ],
  [
    "services:\n  api:\n    appMount: 7",
    ["services", "api", "appMount"],
    "Expected false, a destination string, or an app-mount object",
  ],
  [
    "services:\n  api:\n    healthcheck: 5",
    ["services", "api", "healthcheck"],
    "Expected false, a command string, an argv array, or a healthcheck object",
  ],
  [
    'services:\n  api:\n    healthcheck: ""',
    ["services", "api", "healthcheck"],
    "Healthcheck command must not be empty; use healthcheck: false to disable the probe.",
  ],
  ["services:\n  api:\n    primary: maybe", ["services", "api", "primary"], "Expected boolean"],
  ["services:\n  web: nginx", ["services", "web"], "Expected object"],
  [
    "services:\n  api:\n    mounts:\n      - type: invalid\n        source: data\n        target: /data",
    ["services", "api", "mounts", 0, "type"],
    'Expected "bind" | "tmpfs" | "volume"',
  ],
  ["tooling:\n  bar:\n    cmd: 5", ["tooling", "bar", "cmd"], "Expected string | array"],
  ["tooling:\n  bar:\n    arguments: true", ["tooling", "bar", "arguments"], "Expected false"],
  ["tooling:\n  foo: true", ["tooling", "foo"], TOOLING_TASK_EXPECTATION],
  ["tooling:\n  foo: 5", ["tooling", "foo"], TOOLING_TASK_EXPECTATION],
  ["tooling:\n  foo: !override 5", ["tooling", "foo"], TOOLING_TASK_EXPECTATION],
] as const)("merges an unchanged defect from %s into one readable finding", async (yaml, path, message) => {
  // Given
  const cwd = await mkdtemp(join(tmpdir(), "lando-lint-message-"));
  try {
    await writeFile(join(cwd, ".lando.yml"), `name: lint-parity\n${yaml}\n`);
    // When
    const result = await Effect.runPromise(lintLandofile({ cwd }));
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        rule: "landofile.validation",
        path,
        message,
        scopes: ["fragment", "effective"],
        source: { file: join(cwd, ".lando.yml"), layer: "canonical", path },
      }),
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each([
  [
    "services:\n  api:\n    type: nginx\n    mounts:\n      - type: tmpfs\n        target: /data\n        size: 5",
    ["services", "api", "mounts", 0, "size"],
    'Remove the unknown key "size"; it is not part of the canonical Landofile schema.',
  ],
] as const)("merges suggestions for an unchanged defect from %s", async (yaml, path, suggestion) => {
  // Given
  const cwd = await mkdtemp(join(tmpdir(), "lando-lint-suggestion-"));
  try {
    await writeFile(join(cwd, ".lando.yml"), `name: lint-parity\n${yaml}\n`);
    // When
    const result = await Effect.runPromise(lintLandofile({ cwd }));
    // Then
    expect(result.violations).toEqual([
      expect.objectContaining({ path, suggestion, scopes: ["fragment", "effective"] }),
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("merges a missing required key reported by both issue-conversion paths", () => {
  // Given
  const parsed = { name: "lint-parity", services: { api: { mounts: [{ type: "tmpfs" }] } } };
  const decoded = Schema.decodeUnknownResult(LandofileShape)(parsed, {
    onExcessProperty: "error",
    errors: "all",
  });
  if (Result.isSuccess(decoded)) throw new Error("Expected the missing mount target to fail validation");
  // When
  const fragment = violationsFromSchema(decoded.failure.issue, parsed);
  const effective = validationErrorFromCause(".lando.yml", parsed, decoded.failure).issues;
  const findings = mergeLintFindings([
    ...fragment.map((issue) => ({ ...issue, scopes: ["fragment"] as const })),
    ...effective.map((issue) => ({
      ...issue,
      rule: "landofile.validation",
      severity: "error" as const,
      scopes: ["effective"] as const,
    })),
  ]);
  // Then
  expect(findings).toEqual([
    expect.objectContaining({
      path: ["services", "api", "mounts", 0, "target"],
      suggestion: 'Add the required "target" field.',
      scopes: ["fragment", "effective"],
    }),
  ]);
});

test("suggests the required key at effective scope when a partial fragment omits it", async () => {
  // Given
  const cwd = await mkdtemp(join(tmpdir(), "lando-lint-missing-"));
  try {
    await writeFile(
      join(cwd, ".lando.yml"),
      "name: lint-parity\nservices:\n  api:\n    mounts:\n      - type: tmpfs\n",
    );
    // When
    const result = await Effect.runPromise(lintLandofile({ cwd }));
    // Then
    expect(result.violations).toEqual([
      expect.objectContaining({
        path: ["services", "api", "mounts", 0, "target"],
        suggestion: 'Add the required "target" field.',
        scopes: ["effective"],
      }),
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
