import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

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
    expect(result.violations.map(({ path }) => path)).toEqual(
      field === undefined ? [] : [["services", "web", "routes", 0, field]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
