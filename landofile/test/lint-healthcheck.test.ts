import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { lintLandofileSnapshot } from "../src/lint.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lint-healthcheck-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const write = (file: string, body: string) => writeFile(join(root, file), body);
const lint = () =>
  Effect.runPromise(
    lintLandofileSnapshot(
      { cwd: root },
      {
        ports: makeTestLandofilePorts(root),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      },
    ),
  );

for (const marker of ["CMD", "CMD-SHELL", "NONE"]) {
  test(`warns without changing literal argv beginning with ${marker}`, async () => {
    // Given a bare Lando argv, not a Compose test object.
    await write(".lando.yml", `name: warning\nservices:\n  web:\n    healthcheck: ["${marker}", "true"]\n`);
    // When
    const { result, resolved } = await lint();
    // Then
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([
      expect.objectContaining({
        rule: "healthcheck.bare-compose-marker",
        severity: "warning",
        scopes: ["effective"],
        path: ["services", "web", "healthcheck"],
        source: {
          file: join(root, ".lando.yml"),
          layer: "canonical",
          path: ["services", "web", "healthcheck"],
        },
        line: 4,
        column: 5,
      }),
    ]);
    expect(Object.values(resolved?.services ?? {})[0]?.healthcheck).toEqual({
      kind: "command",
      command: [marker, "true"],
    });
  });
}

test("warns only for surviving dialect fields contributed by different sources", async () => {
  // Given
  await write(
    ".lando.base.yml",
    "services:\n  web:\n    healthcheck:\n      test: [CMD, echo]\n      interval: 5s\n",
  );
  await write(
    ".lando.yml",
    "name: warning\nservices:\n  web:\n    healthcheck:\n      command: echo ready\n",
  );
  // When
  const { result, resolved } = await lint();
  // Then
  expect(result.valid).toBe(true);
  expect(result.violations).toEqual([
    expect.objectContaining({ rule: "healthcheck.mixed-dialects", severity: "warning" }),
  ]);
  expect(Object.values(resolved?.services ?? {})[0]?.healthcheck).toEqual({
    kind: "command",
    command: "echo ready",
  });
});

for (const upper of [
  "false",
  "!override\n      command: echo ready",
  "!reset",
  "echo ready",
  "[echo, ready]",
]) {
  test(`does not warn for discarded Compose fields after ${upper}`, async () => {
    // Given
    await write(".lando.base.yml", "services:\n  web:\n    healthcheck:\n      test: [CMD, echo]\n");
    await write(".lando.yml", `name: warning\nservices:\n  web:\n    healthcheck: ${upper}\n`);
    // When
    const { result } = await lint();
    // Then
    expect(result.violations.filter((issue) => issue.severity === "warning")).toEqual([]);
  });
}

for (const healthcheck of [
  "test: [CMD, echo]",
  "command: echo ready\n      test: [CMD, echo]",
  "retries: 3\n      disable: false",
]) {
  test(`does not infer cross-source mixing from ${healthcheck}`, async () => {
    // Given
    await write(".lando.base.yml", "services:\n  web:\n    healthcheck:\n      retries: 2\n");
    await write(".lando.yml", `name: warning\nservices:\n  web:\n    healthcheck:\n      ${healthcheck}\n`);
    // When
    const { result } = await lint();
    // Then
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });
}
