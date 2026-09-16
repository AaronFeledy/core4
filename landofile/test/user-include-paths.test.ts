import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { resolveLandofileIncludes } from "../src/includes.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

describe("user include path validation", () => {
  test.each(["non-yaml", "absolute", "lexical-escape"] as const)(
    "rejects a nested %s source even when its target is contained YAML",
    async (kind) => {
      // Given: a selected profile and a readable nested target.
      const root = await mkdtemp(join(tmpdir(), "lando-user-path-review-"));
      const appRoot = join(root, "app");
      const includesRoot = join(root, "includes");
      await mkdir(appRoot);
      await mkdir(includesRoot);
      const target = join(includesRoot, "nested.yml");
      await writeFile(target, "services:\n  web:\n    type: node\n");
      try {
        let source = target;
        if (kind === "non-yaml") {
          source = "./nested.txt";
          await writeFile(join(includesRoot, "nested.txt"), "services:\n  web:\n    type: node\n");
        } else if (kind === "lexical-escape") {
          await symlink(includesRoot, join(root, "alias"), "junction");
          source = "../alias/nested.yml";
        }
        await writeFile(join(includesRoot, "profile.yml"), `includes:\n  - '${source}'\n`);

        // When: the resolver follows the selected profile.
        const result = await Effect.runPromise(
          Effect.either(
            resolveLandofileIncludes({
              landofile: { includes: ["user:profile.yml"] },
              appRoot,
              cacheRoot: join(root, "cache"),
              ports: makeTestLandofilePorts(join(root, "cache"), includesRoot),
              stateStore: makeTestLandofileStateStore(),
            }),
          ),
        );

        // Then: lexical validation precedes reading or realpath canonicalization.
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") expect(result.left._tag).toBe("LandofileIncludeError");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
