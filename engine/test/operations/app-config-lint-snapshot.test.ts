import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as TsLoader from "@lando/landofile/ts-loader";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

test("event validation reuses the retained TypeScript snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-event-lint-snapshot-"));
  const evaluate = spyOn(TsLoader, "loadLandofileTs");
  try {
    await writeFile(
      join(root, ".lando.ts"),
      'export default { name: "once", tooling: { check: { cmd: "echo checked" } }, events: { "pre-check": ["echo ready"] } };\n',
    );
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    expect(result.valid).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);
  } finally {
    evaluate.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("reports event violations alongside masked fragment findings from the retained snapshot", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-event-lint-fragment-"));
  try {
    await writeFile(join(root, ".lando.base.yml"), "runtime: wrong\n");
    await writeFile(
      join(root, ".lando.yml"),
      "name: events\nruntime: 4\nevents:\n  pre-unknown-task:\n    - echo wrong\n",
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then
    expect(result.valid).toBe(false);
    expect(result.file).toBe(join(root, ".lando.base.yml"));
    expect(result.violations).toEqual([
      expect.objectContaining({ path: ["runtime"], scopes: ["fragment"] }),
      expect.objectContaining({
        rule: "landofile.event",
        path: ["events", "pre-unknown-task"],
        scopes: ["effective"],
        source: expect.objectContaining({ file: join(root, ".lando.yml") }),
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
