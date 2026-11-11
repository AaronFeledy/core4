import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolveAuthoredIncludes as resolveLandofileIncludes } from "./include-pipeline.ts";
import {
  makeNpmPackageTarball,
  makeTestLandofilePorts,
  makeTestLandofileStateStore,
  makeTestNpmRegistry,
} from "./support.ts";

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
    const tarball = makeNpmPackageTarball({
      "fragments/web.yml": "services:\n  web:\n    type: node\n",
    });
    const npmRegistry = makeTestNpmRegistry({
      name: "@acme/fragments",
      version: "1.2.3",
      tarball,
      tags: { next: "1.2.3", latest: "1.2.3" },
      onPackument: (name) => {
        packageSpecs.push(`${name}@next`);
      },
    });

    // When
    const result = await Effect.runPromise(
      resolveLandofileIncludes({
        landofile: { includes: ["npm:@acme/fragments/fragments/web.yml@next"] },
        appRoot,
        cacheRoot,
        stateStore: makeTestLandofileStateStore(cacheRoot),
        ports: makeTestLandofilePorts(cacheRoot, cacheRoot, { npmRegistry }),
        deps: { npmRegistry },
      }),
    );

    // Then
    expect(packageSpecs).toEqual(["@acme/fragments@next"]);
    expect(result.services?.[ServiceName.make("web")]?.type).toBe("node");
  });
});
