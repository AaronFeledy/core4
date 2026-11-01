import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import { resolveAuthoredIncludes as resolveLandofileIncludes } from "./include-pipeline.ts";
import { makeTestLandofileStateStore, makeTestPublicationPort } from "./support.ts";

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
    const bytes = new Uint8Array([1, 2, 3]);

    // When
    const result = await Effect.runPromise(
      resolveLandofileIncludes({
        landofile: { includes: ["npm:@acme/fragments/fragments/web.yml@next"] },
        appRoot,
        cacheRoot,
        stateStore: makeTestLandofileStateStore(),
        ports: {
          resolveUserCacheRoot: () => cacheRoot,
          resolveUserIncludesDir: () => cacheRoot,
          npmRecipeSource: {
            fetchTarball: async (resolved) => {
              expect(resolved.packageName).toBe("@acme/fragments");
              return bytes;
            },
            resolve: async (packageSpec) => {
              packageSpecs.push(packageSpec);
              return {
                packageName: "@acme/fragments",
                version: "1.2.3",
                dist: {
                  tarball: "https://registry.example/fragments.tgz",
                  shasum: createHash("sha1").update(bytes).digest("hex"),
                },
              };
            },
          },
          git: { clone: async () => ({ commitSha: "unused" }) },
          tarball: {
            fetch: async () => {
              throw new Error("npm includes must use the credential-aware npm port");
            },
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
    expect(result.services?.[ServiceName.make("web")]?.type).toBe("node");
  });
});
