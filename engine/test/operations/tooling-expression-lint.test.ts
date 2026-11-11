import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

test("unknown flag references load successfully and lint at the executable site with a closest name", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-input-lint-"));
  try {
    await Bun.write(
      join(root, ".lando.yml"),
      "name: scopes\ntooling:\n  inspect:\n    service: ':host'\n    flags:\n      name:\n        default: world\n    cmd: echo {{ flags.naem }}\n",
    );
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    expect(result).toMatchObject({
      valid: false,
      violations: [
        {
          rule: "landofile.tooling",
          path: ["tooling", "inspect", "cmd"],
          suggestion: expect.stringContaining('Did you mean "name"?'),
        },
      ],
    });
    expect(result.violations.filter((issue) => issue.rule === "landofile.load")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
