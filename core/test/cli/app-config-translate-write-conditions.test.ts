import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigTranslateSourceId, PortablePath } from "@lando/sdk/schema";
import { Effect } from "effect";
import { writeTranslateTargets } from "../../src/cli/commands/app-config-translate-write.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("rejects a changed unselected lower layer without changing the selected target", async () => {
  // Given
  const appRoot = await mkdtemp(join(tmpdir(), "translate-conditions-"));
  roots.push(appRoot);
  const lower = "runtime: 4\nname: old\n";
  const selected = "services: {}\n";
  await Bun.write(join(appRoot, ".lando.yml"), "runtime: 4\nname: changed\n");
  await Bun.write(join(appRoot, ".lando.local.yml"), selected);
  const documents = [
    [".lando.yml", lower],
    [".lando.local.yml", selected],
  ].map(([path = "", content = ""]) => ({
    sourceId: ConfigTranslateSourceId.make(path),
    layerId: path === ".lando.yml" ? "canonical" : "local",
    path: PortablePath.make(path),
    mediaType: "application/yaml",
    bytes: new TextEncoder().encode(content),
    contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(content).digest("hex")}`,
  }));
  // When
  const result = await Effect.runPromise(
    Effect.either(
      writeTranslateTargets({
        appRoot,
        privateFileAccess: ownerOnlyFileAccess,
        documents,
        shape: { mode: "single-layer", selectedSourceIds: [".lando.local.yml"], writableLayerIds: ["local"] },
        preview: {
          mode: "preview",
          inputPath: appRoot,
          translator: "lando3",
          target: "lando4",
          files: [".lando.local.yml"],
          content: "runtime: 4\n",
          targets: [{ layer: "local", path: join(appRoot, ".lando.local.yml"), content: "runtime: 4\n" }],
          diagnostics: [],
          deletions: [],
        },
      }),
    ),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ConfigTranslateError" } });
  expect(await Bun.file(join(appRoot, ".lando.local.yml")).text()).toBe(selected);
  expect(await Bun.file(join(appRoot, ".lando.yml")).text()).toBe("runtime: 4\nname: changed\n");
  expect((await readdir(appRoot)).sort()).toEqual([".lando.local.yml", ".lando.yml"]);
});
