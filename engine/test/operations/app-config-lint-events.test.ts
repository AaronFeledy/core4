import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

test("reports unknown events alongside resolved route findings", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-event-route-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      'name: events\nservices:\n  web:\n    type: nginx\n    routes:\n      - hostname: "{{ app.name }}.lndo.site:8080"\nevents:\n  pre-nope: [echo hi]\n',
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations.map(({ rule, path }) => ({ rule, path }))).toEqual([
      { rule: "landofile.route", path: ["services", "web", "routes", 0, "hostname"] },
      { rule: "landofile.event", path: ["events", "pre-nope"] },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports every unknown event and suggests a close spelling", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-event-typo-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: events\nevents:\n  pre-strat: [echo hi]\n  post-nope: [echo hi]\n",
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations.map(({ rule, path }) => ({ rule, path }))).toEqual([
      { rule: "landofile.event", path: ["events", "pre-strat"] },
      { rule: "landofile.event", path: ["events", "post-nope"] },
    ]);
    expect(result.violations[0]?.suggestion).toBe('Did you mean "pre-start"?');
    expect(result.violations[1]?.suggestion).toStartWith("Use one of: ");
    expect(result.violations[0]?.source).toMatchObject({
      file: join(root, ".lando.yml"),
      layer: "canonical",
      path: ["events", "pre-strat"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defers unknown event checks while a service cannot resolve", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-event-unavailable-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: events\nservices:\n  web:\n    type: nonexistent-service\nevents:\n  pre-nope: [echo hi]\n",
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations.map(({ rule }) => rule)).toEqual(["landofile.service"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts remote sync hooks and rejects tasks whose brackets bind reserved events", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-event-collision-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: events\ntooling:\n  start:\n    service: ':host'\n    cmd: echo start\n  pull:\n    service: ':host'\n    cmd: echo pull\nevents:\n  post-pull: [echo pulled]\n  post-code-sync: [echo synced]\n",
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations.map(({ rule, path, message }) => ({ rule, path, message }))).toEqual([
      {
        rule: "landofile.tooling",
        path: ["tooling", "pull"],
        message:
          "Tooling task pull would bind post-pull, which Lando reserves for its own app and remote sync events.",
      },
      {
        rule: "landofile.tooling",
        path: ["tooling", "start"],
        message:
          "Tooling task start would bind pre-start and post-start, which Lando reserves for its own app and remote sync events.",
      },
    ]);
    expect(result.violations[0]?.suggestion).toBe("Rename tooling task pull.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
