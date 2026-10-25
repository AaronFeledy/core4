import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { lintLandofile } from "../src/lint.ts";

test.each([
  ["services:\n  api:\n    environment: 5", ["services", "api", "environment"], "Expected object"],
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
  ["services:\n  web: nginx", ["services", "web"], "Expected ServiceConfigInput"],
  [
    "services:\n  api:\n    mounts:\n      - type: invalid\n        source: data\n        target: /data",
    ["services", "api", "mounts", 0, "type"],
    'Expected "bind" | "tmpfs" | "volume"',
  ],
  ["tooling:\n  bar:\n    cmd: 5", ["tooling", "bar", "cmd"], "Expected string | array"],
  ["tooling:\n  bar:\n    arguments: true", ["tooling", "bar", "arguments"], "Expected false"],
  ["tooling:\n  foo: false", ["tooling", "foo"], "Expected object"],
  ["tooling:\n  bar: disabled", ["tooling", "bar"], "Expected object"],
  ["tooling:\n  baz: echo hi", ["tooling", "baz"], "Expected object"],
  ["tooling:\n  foo: !override 5", ["tooling", "foo"], "Expected object"],
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
