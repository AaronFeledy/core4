import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

const lint = async (service: string) => {
  const root = await mkdtemp(join(tmpdir(), "lando-mount-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: mounts\nservices:\n  web:\n    type: node:22\n${service}`,
    );
    return await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([
  {
    name: "two Lando mounts at one destination",
    service: "    mounts: ['./x:/app/vendor/']\n    storage: [/app/vendor]\n",
    paths: [
      ["services", "web", "storage", 0],
      ["services", "web", "mounts", 0],
    ],
  },
  {
    name: "excludes on a volume mount",
    service: "    mounts:\n      - type: volume\n        target: /data\n        excludes: [tmp]\n",
    paths: [["services", "web", "mounts", 0]],
  },
  {
    name: "a glob include",
    service: "    appMount:\n      target: /app\n      includes: ['vendor/*']\n",
    paths: [["services", "web", "appMount", "includes"]],
  },
  {
    name: "conflicting tmpfs access modes",
    service: "    tmpfs: ['/run/x:ro,rw']\n",
    paths: [["services", "web", "tmpfs", 0]],
  },
])("lint reports $name without planning", async ({ service, paths }) => {
  // When lint runs the resolve pass shared with planning.
  const result = await lint(service);

  // Then the authored mount problem is a violation at its source paths.
  expect(result.valid).toBe(false);
  expect(result.violations.map(({ path }) => path)).toEqual([...paths]);
});

test("lint accepts a bind nested inside an excluded directory", async () => {
  const result = await lint(
    "    mounts: ['./vendor/acme/sdk:/app/vendor/acme/sdk']\n    tmpfs: [/scratch]\n",
  );
  expect(result.violations).toEqual([]);
  expect(result.valid).toBe(true);
});
