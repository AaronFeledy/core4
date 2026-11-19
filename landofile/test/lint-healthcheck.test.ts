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

test.each([
  { role: "healthcheck", body: "target: host\n      command: ready", valid: false },
  { role: "healthcheck", body: "user: root\n      disable: true", valid: false },
  { role: "healthcheck", body: "target: host\n      disable: true", valid: false },
  { role: "healthcheck", body: "target: service\n      command: ready", valid: true },
  { role: "readiness", body: "target: host\n      command: ready", valid: true },
  { role: "readiness", body: "target: host\n      user: root\n      command: ready", valid: false },
  { role: "readiness", body: "target: host", valid: false },
])("lint validates the composed $role execution role: $body", async ({ role, body, valid }) => {
  // Given
  await write(".lando.yml", `name: probe-role\nservices:\n  web:\n    ${role}:\n      ${body}\n`);
  // When
  const { result } = await lint();
  // Then
  expect(result.valid).toBe(valid);
  if (!valid)
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        rule: `${role}.execution-target`,
        path: ["services", "web", role],
        severity: "error",
      }),
    );
});

test.each([
  { authored: "target: host", expected: { target: "host" } },
  { authored: "target: service\n      user: 1001:1002", expected: { target: "service", user: "1001:1002" } },
])(
  "shared execution metadata composes without replacing the Compose command or warning",
  async ({ authored, expected }) => {
    // Given
    await write(
      ".lando.base.yml",
      "services:\n  web:\n    readiness:\n      test: [CMD, echo, ready]\n      interval: 500ms\n",
    );
    await write(".lando.yml", `name: shared-probe\nservices:\n  web:\n    readiness:\n      ${authored}\n`);
    // When
    const { result, resolved } = await lint();
    // Then
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(Object.values(resolved?.document.services ?? {})[0]?.readiness).toEqual({
      kind: "command",
      command: ["echo", "ready"],
      intervalSeconds: 0.5,
      ...expected,
    });
  },
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
    expect(Object.values(resolved?.document.services ?? {})[0]?.healthcheck).toEqual({
      kind: "command",
      command: [marker, "true"],
    });
  });
}

test.each(["healthcheck", "readiness"] as const)(
  "warns when %s dialects come from different sources",
  async (role) => {
    // Given
    await write(
      ".lando.base.yml",
      `services:\n  web:\n    ${role}:\n      test: [CMD, echo]\n      interval: 5s\n`,
    );
    await write(".lando.yml", `name: warning\nservices:\n  web:\n    ${role}:\n      command: echo ready\n`);
    // When
    const { result, resolved } = await lint();
    // Then
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: `${role}.mixed-dialects`, severity: "warning" }),
    ]);
    expect(Object.values(resolved?.document.services ?? {})[0]?.[role]).toEqual({
      kind: "command",
      command: "echo ready",
    });
  },
);

test.each(["healthcheck", "readiness"] as const)(
  "warns when both %s start-interval aliases survive across sources",
  async (role) => {
    await write(
      ".lando.base.yml",
      `services:\n  web:\n    ${role}:\n      test: [CMD, echo]\n      start_interval: 1s\n`,
    );
    await write(".lando.yml", `name: aliases\nservices:\n  web:\n    ${role}:\n      startInterval: 2s\n`);

    const { result, resolved } = await lint();

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: `${role}.mixed-dialects`, severity: "warning" }),
    ]);
    expect(Object.values(resolved?.document.services ?? {})[0]?.[role]).toMatchObject({
      startInterval: "2s",
    });
  },
);

test.each(["healthcheck", "readiness"] as const)("refuses mixed %s timing from one source", async (role) => {
  await write(
    ".lando.yml",
    `name: mixed\nservices:\n  web:\n    ${role}:\n      command: echo ready\n      interval: 1s\n      timeout: 2s\n`,
  );

  const { result } = await lint();

  expect(result.valid).toBe(false);
  expect(result.violations).toEqual(
    [
      ["interval", "intervalSeconds", 6],
      ["timeout", "timeoutSeconds", 7],
    ].map(([key, replacement, line]) =>
      expect.objectContaining({
        rule: `${role}.mixed-dialects`,
        severity: "error",
        path: ["services", "web", role, key],
        source: { file: join(root, ".lando.yml"), layer: "canonical", path: ["services", "web", role, key] },
        line,
        suggestion: expect.stringContaining(`\`${replacement}:\``),
      }),
    ),
  );
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
  "command: echo ready\n      intervalSeconds: 0.5",
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
