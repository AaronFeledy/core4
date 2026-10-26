import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheError, LandofileFormConflictError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { readAppPlanSourceFingerprint } from "../../src/cache/app-plan.ts";
import {
  readAppCommandCache,
  readFreshAppCommandCacheForCwd,
  writeAppCommandCacheStrict,
} from "../../src/cache/command-index-writer.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-cache-conflict-"));
  await writeFile(join(root, ".lando.yml"), "name: cache-conflict\n");
  await writeFile(join(root, ".lando.ts"), 'export default { name: "cache-conflict" };\n');
});
afterEach(() => rm(root, { recursive: true, force: true }));

const operations: ReadonlyArray<
  readonly [string, () => Effect.Effect<unknown, CacheError | LandofileFormConflictError>]
> = [
  ["plan fingerprint", () => readAppPlanSourceFingerprint(root)],
  ["fresh command index", () => readFreshAppCommandCacheForCwd({ cwd: root })],
  [
    "command index read",
    () => readAppCommandCache({ cwd: root, landofile: { name: "cache-conflict" }, entries: [] }),
  ],
  [
    "strict command index write",
    () => writeAppCommandCacheStrict({ cwd: root, landofile: { name: "cache-conflict" }, entries: [] }),
  ],
];

for (const [name, operation] of operations) {
  test(`${name} preserves the discovery conflict instead of a CacheError`, async () => {
    // Given conflicting forms created before each operation
    // When
    const result = await Effect.runPromise(operation().pipe(Effect.result));
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "LandofileFormConflictError",
        yamlPath: join(root, ".lando.yml"),
        typescriptPath: join(root, ".lando.ts"),
      },
    });
  });
}
