import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadLandofileLayers } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

test("loads a tooling event when its task exists only in an included fragment", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-included-event-"));
  try {
    const file = join(root, ".lando.yml");
    await writeFile(
      file,
      "name: included-events\nincludes:\n  - ./tasks.yml\nevents:\n  pre-build:\n    - echo preparing\n",
    );
    await writeFile(join(root, "tasks.yml"), "tooling:\n  build:\n    cmd: echo build\n");
    // When
    const result = await Effect.runPromise(
      Effect.either(
        loadLandofileLayers(root, file, {
          ports: makeTestLandofilePorts(join(root, ".cache")),
          stateStore: makeTestLandofileStateStore(),
          templates: { modules: [] },
        }),
      ),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Right" });
    if (result._tag === "Right") {
      expect(result.right.tooling?.build).toBeDefined();
      expect(result.right.events?.["pre-build"]).toEqual(["echo preparing"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
