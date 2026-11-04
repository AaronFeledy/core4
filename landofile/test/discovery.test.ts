import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LandofileFormConflictError, LandofileNotFoundError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { findAppRoot, findLandofilePath } from "../src/discovery.ts";
import { presentLandofileLayers } from "../src/layers.ts";
import { findDiscoveredLandofilePath } from "../src/service.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-discovery-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

for (const basename of [".lando", ".lando.local"] as const) {
  test(`finds the root despite conflicting ${basename} forms from a nested cwd`, async () => {
    // Given
    const nested = join(root, "nested");
    await mkdir(nested);
    await writeFile(join(root, `${basename}.yml`), "name: yaml-app\n");
    await writeFile(join(root, `${basename}.ts`), 'export default { name: "ts-app" };\n');
    // When
    const found = await Effect.runPromise(findAppRoot(nested));
    // Then
    expect(found).toBe(root);
  });
}

const discoveries: ReadonlyArray<
  (cwd: string) => Effect.Effect<unknown, LandofileFormConflictError | LandofileNotFoundError>
> = [presentLandofileLayers, findLandofilePath, findDiscoveredLandofilePath];
for (const discover of discoveries) {
  test(`${discover.name} fails in the typed channel for conflicting forms`, async () => {
    // Given
    const yamlPath = join(root, ".lando.yml");
    const typescriptPath = join(root, ".lando.ts");
    await writeFile(yamlPath, "name: yaml-app\n");
    await writeFile(typescriptPath, 'export default { name: "ts-app" };\n');
    // When
    const result = await Effect.runPromise(discover(root).pipe(Effect.result));
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LandofileFormConflictError", layer: "canonical", yamlPath, typescriptPath },
    });
  });
}

test("fails with typed NotFound when no layer exists", async () => {
  // Given an empty temporary directory
  // When
  const result = await Effect.runPromise(findDiscoveredLandofilePath(root).pipe(Effect.result));
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileNotFoundError", cwd: root } });
});

test("not-found reports the stop marker, searched range, and marker remediation", async () => {
  const nested = join(root, "nested");
  await mkdir(nested);
  await writeFile(join(root, ".lando.stop"), "");
  const result = await Effect.runPromise(findDiscoveredLandofilePath(nested).pipe(Effect.result));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toMatchObject({ _tag: "LandofileNotFoundError", cwd: nested });
    expect(result.failure.message).toContain(`from ${nested} through ${root}`);
    expect(result.failure.message).toContain(`.lando.stop at ${root}`);
    expect(result.failure.remediation).toContain(`move/remove the .lando.stop at ${root}`);
  }
});
