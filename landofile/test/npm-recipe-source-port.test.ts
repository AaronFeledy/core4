import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { resolveLandofileIncludes } from "../src/includes.ts";
import { makeTestPublicationPort } from "./support.ts";

describe("npm include recipe-source port", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("delegates package parsing and version resolution to the injected port", async () => {
    // Given
    const appRoot = await mkdtemp(join(tmpdir(), "lando-npm-port-app-"));
    const cacheRoot = await mkdtemp(join(tmpdir(), "lando-npm-port-cache-"));
    roots.push(appRoot, cacheRoot);
    const packageSpecs: string[] = [];

    // When
    const result = await Effect.runPromise(
      resolveLandofileIncludes({
        landofile: { includes: ["npm:@acme/fragments/fragments/web.yml@next"] },
        appRoot,
        cacheRoot,
        ports: {
          resolveUserCacheRoot: () => cacheRoot,
          npmRecipeSource: {
            resolve: async (packageSpec) => {
              packageSpecs.push(packageSpec);
              return {
                packageName: "@acme/fragments",
                version: "1.2.3",
                dist: { tarball: "https://registry.example/fragments.tgz" },
              };
            },
          },
          git: { clone: async () => ({ commitSha: "unused" }) },
          tarball: {
            fetch: async () => new Uint8Array([1, 2, 3]),
            extract: async (_archive, destDir) => {
              const fragmentDir = join(destDir, "package", "fragments");
              await mkdir(fragmentDir, { recursive: true });
              await writeFile(join(fragmentDir, "web.yml"), "services:\n  web:\n    type: node\n");
            },
          },
          publication: makeTestPublicationPort(),
        },
      }),
    );

    // Then
    expect(packageSpecs).toEqual(["@acme/fragments@next"]);
    expect(result.services?.web?.type).toBe("node");
  });
});
