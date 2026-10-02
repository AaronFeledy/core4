import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import { writeTranslateTargets } from "../../src/cli/commands/app-config-translate-write.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { failure, originals, snapshot, withFixture } from "./translate-lando3-fixture.ts";

test.each(["foreign-path", "unwritable-layer", "foreign-deletion"] as const)(
  "rejects %s before staging",
  (kind) =>
    withFixture(async ({ root }) => {
      // Given
      const path = join(root, kind === "foreign-path" ? "other.yml" : ".lando.local.yml");
      // When
      const result = await failure(
        writeTranslateTargets({
          appRoot: root,
          documents: [],
          privateFileAccess: ownerOnlyFileAccess,
          shape: {
            mode: "full",
            selectedSourceIds: [],
            writableLayerIds: kind === "unwritable-layer" ? ["canonical"] : ["local"],
          },
          preview: {
            mode: "preview",
            inputPath: join(root, ".lando.yml"),
            translator: "lando3",
            target: "lando4",
            files: [],
            content: "",
            diagnostics: [],
            targets: kind === "foreign-deletion" ? [] : [{ layer: "local", path, content: "{}\n" }],
            deletions:
              kind === "foreign-deletion"
                ? [{ sourceId: ConfigTranslateSourceId.make("other.yml"), reason: "test" }]
                : [],
          },
        }),
      );
      // Then
      expect(result).toMatchObject({
        _tag: "Left",
        left: { _tag: "ConfigTranslateError", remediation: expect.any(String) },
      });
      expect(await snapshot(root)).toEqual(originals);
      expect((await readdir(root)).sort()).toEqual(Object.keys(originals).sort());
    }),
);
