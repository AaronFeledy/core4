import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLintResult } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

test.each([
  { endpoints: "", route: "missing.lndo.site", valid: false },
  { endpoints: "    ports: [80]\n", route: "tcp.lndo.site", valid: false },
  { endpoints: "    endpoints: []\n", route: "empty.lndo.site", valid: false },
  {
    endpoints:
      "    endpoints:\n      - _tag: internal\n        name: web\n        protocol: http\n        port: 8080\n",
    route: "valid.lndo.site",
    valid: true,
  },
])("checks authored HTTP binding for $route", async ({ endpoints, route, valid }) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-route-binding-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: routes\nservices:\n  web:\n    type: compose\n    image: nginx:alpine\n${endpoints}    routes:\n      - ${route}\n`,
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(valid);
    expect(result.violations.map(({ rule, path }) => ({ rule, path }))).toEqual(
      valid ? [] : [{ rule: "landofile.route", path: ["services", "web", "routes", 0] }],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { route: 'hostname: "{{ app.name }}.lndo.site:8080"', valid: false, field: "hostname" },
  { route: '"{{ app.name }}.lndo.site/x"', valid: true },
  { route: 'hostname: "{{ app.name }}.lndo.site"', valid: true },
  { route: 'hostname: app.site\n        pathPrefix: "{{ app.name }}"', valid: false, field: "pathPrefix" },
])("lints resolved route $route with valid=$valid", async ({ route, valid, field }) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-resolved-route-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: My App\nservices:\n  web:\n    type: nginx\n    routes:\n      - ${route}\n`,
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(valid);
    expect(Schema.is(ConfigLintResult)(result)).toBe(true);
    expect(result.violations.map(({ path }) => path)).toEqual(
      field === undefined ? [] : [["services", "web", "routes", 0, field]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([true, false])("preserves healthcheck warnings with route validity %s", async (valid) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-route-lint-warning-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: routes\nservices:\n  web:\n    type: nginx\n    healthcheck: [CMD, echo]\n    routes:\n      - hostname: "{{ app.name }}.lndo.site${valid ? "" : ":8080"}"\n`,
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(valid);
    expect(result.violations.map(({ rule, severity }) => ({ rule, severity }))).toEqual([
      { rule: "healthcheck.bare-compose-marker", severity: "warning" },
      ...(valid ? [] : [{ rule: "landofile.route", severity: "error" } as const]),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains fragment findings when evaluated routes add effective findings", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-route-lint-fragment-"));
  try {
    await writeFile(join(root, ".lando.base.yml"), "runtime: wrong\n");
    await writeFile(
      join(root, ".lando.yml"),
      'name: routes\nruntime: 4\nservices:\n  web:\n    type: nginx\n    routes:\n      - hostname: "{{ app.name }}.lndo.site:8080"\n',
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["runtime"],
          scopes: ["fragment"],
          source: expect.objectContaining({ file: join(root, ".lando.base.yml"), layer: "base" }),
        }),
        expect.objectContaining({
          path: ["services", "web", "routes", 0, "hostname"],
          scopes: ["effective"],
          source: expect.objectContaining({
            file: join(root, ".lando.yml"),
            layer: "canonical",
            path: ["services", "web", "routes", 0, "hostname"],
          }),
        }),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports static route findings once when evaluated routes are also invalid", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-route-lint-dedup-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      'name: routes\nservices:\n  web:\n    type: nginx\n    routes:\n      - hostname: static.lndo.site:8080\n      - hostname: "{{ app.name }}.lndo.site:8080"\n',
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.violations.map(({ path }) => path)).toEqual([
      ["services", "web", "routes", 0, "hostname"],
      ["services", "web", "routes", 1, "hostname"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
