import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { LandofileIncludeDeps } from "../src/include-context.ts";
import { resolveAuthoredIncludes, updateAuthoredIncludes } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-relative-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const options = () => ({
  appRoot: root,
  cacheRoot: join(root, "cache"),
  ports: makeTestLandofilePorts(join(root, "cache")),
  stateStore: makeTestLandofileStateStore(),
});
const populate = async (dest: string, child = "./nested/child.yml") => {
  await mkdir(join(dest, "fragments", "nested"), { recursive: true });
  await Bun.write(join(dest, "fragments", "parent.yml"), `includes:\n  - ${child}\n`);
  await Bun.write(join(dest, "fragments", "nested", "child.yml"), "includes:\n  - ../leaf.yml\n");
  await Bun.write(join(dest, "fragments", "leaf.yml"), "services:\n  web:\n    type: php\n");
};

test("warm git symlink fragment keeps relative children inside its snapshot", async () => {
  // Given: the requested fragment resolves to a file at a shallower depth in the checkout.
  const snapshot = join(root, "cache", "includes", "git", SHA);
  const parent = "includes:\n  - ./child.yml\n";
  const child = "services:\n  web:\n    type: php\n";
  await mkdir(join(snapshot, "fragments"), { recursive: true });
  await Bun.write(join(snapshot, "parent.yml"), parent);
  await Bun.write(join(snapshot, "child.yml"), child);
  await symlink("../parent.yml", join(snapshot, "fragments", "parent.yml"));
  const entries = [
    { path: "fragments/parent.yml", version: "main", content: parent },
    { path: "child.yml", version: SHA, content: child },
  ];
  await Bun.write(
    join(root, ".lando.lock.yml"),
    `includes:\n${entries.map((entry) => `  - source: github:acme/shared/${entry.path}\n    version: ${entry.version}\n    resolved: ${SHA}\n    checksum: ${new Bun.CryptoHasher("sha256").update(entry.content).digest("hex")}\n`).join("")}`,
  );
  // When: a warm load reads the symlink without acquiring another checkout.
  const loaded = await Effect.runPromise(
    resolveAuthoredIncludes({
      ...options(),
      landofile: {
        includes: [{ source: "github:acme/shared", path: "fragments/parent.yml", version: "main" }],
      },
    }),
  );
  // Then
  expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
});

for (const indirect of [false, true]) {
  test(`git relative ${indirect ? "a-to-b-to-a" : "self"} include reports a cycle before selector conflict`, async () => {
    // Given: the root selector is a branch, while descendants use the resolved SHA.
    const input = {
      ...options(),
      landofile: { includes: [{ source: "github:acme/shared", path: "a.yml", version: "main" }] },
      deps: {
        gitCloner: {
          clone: async ({ dest }: { dest: string }) => {
            await Bun.write(join(dest, "a.yml"), `includes:\n  - ./${indirect ? "b" : "a"}.yml\n`);
            await Bun.write(join(dest, "b.yml"), "includes:\n  - ./a.yml\n");
            return { commitSha: SHA };
          },
        },
      },
    };
    // When
    const error = await Effect.runPromise(Effect.flip(resolveAuthoredIncludes(input)));
    // Then
    expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "cycle" });
  });
}

for (const kind of ["git", "npm"] as const) {
  test(`${kind} relative descendants pin at the parent revision and load offline when warm`, async () => {
    // Given
    const calls: Array<string | undefined> = [];
    const source = kind === "git" ? "github:acme/shared" : "npm:@acme/shared";
    const revision = kind === "git" ? SHA : "1.2.3";
    const bytes = new Uint8Array();
    const deps: LandofileIncludeDeps =
      kind === "git"
        ? {
            gitCloner: {
              clone: async ({ dest, ref }) => {
                calls.push(ref);
                await populate(dest);
                return { commitSha: SHA };
              },
            },
          }
        : {
            npmRecipeSource: {
              resolve: async (spec) => {
                calls.push(spec);
                return {
                  packageName: "@acme/shared",
                  version: revision,
                  dist: {
                    tarball: "https://example.test/pkg.tgz",
                    shasum: createHash("sha1").update(bytes).digest("hex"),
                  },
                };
              },
            },
            npmFetcher: { fetch: async () => bytes },
            npmExtractor: { extract: async (_bytes, dest) => populate(join(dest, "package")) },
          };
    const input = {
      ...options(),
      landofile: { includes: [{ source, path: "fragments/parent.yml", version: "main" }] },
      deps,
    };
    await Effect.runPromise(resolveAuthoredIncludes(input));
    const acquisitions = calls.length;
    // When
    const loaded = await Effect.runPromise(resolveAuthoredIncludes({ ...input, deps: {} }));
    // Then
    expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
    expect(calls.length).toBe(acquisitions);
    expect(Bun.YAML.parse(await Bun.file(join(root, ".lando.lock.yml")).text())).toMatchObject({
      includes: expect.arrayContaining([
        expect.objectContaining({
          source: `${source}/fragments/nested/child.yml`,
          version: revision,
          resolved: revision,
        }),
        expect.objectContaining({
          source: `${source}/fragments/leaf.yml`,
          version: revision,
          resolved: revision,
        }),
      ]),
    });
    expect(calls).toContain(kind === "git" ? SHA : "@acme/shared@1.2.3");
  });
}

for (const child of ["../../outside.yml", "/outside.yml"]) {
  test(`remote child rejects snapshot escape ${child}`, async () => {
    // Given
    const input = {
      ...options(),
      landofile: { includes: [{ source: "github:acme/shared", path: "fragments/parent.yml" }] },
      deps: {
        gitCloner: {
          clone: async ({ dest }: { dest: string }) => {
            await populate(dest, child);
            return { commitSha: SHA };
          },
        },
      },
    };
    // When
    const error = await Effect.runPromise(Effect.flip(resolveAuthoredIncludes(input)));
    // Then
    expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "outside-root" });
    expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
  });
}

test("parent refresh moves descendant selectors to the refreshed revision", async () => {
  // Given
  let revision = SHA;
  const input = {
    ...options(),
    landofile: {
      includes: [{ source: "github:acme/shared", path: "fragments/parent.yml", version: "main" }],
    },
    deps: {
      gitCloner: {
        clone: async ({ dest }: { dest: string }) => {
          await populate(dest);
          return { commitSha: revision };
        },
      },
    },
  };
  await Effect.runPromise(resolveAuthoredIncludes(input));
  revision = NEW_SHA;
  // When
  const report = await Effect.runPromise(updateAuthoredIncludes(input));
  // Then
  expect(report.entries.find((entry) => entry.source.endsWith("/leaf.yml"))).toMatchObject({
    version: NEW_SHA,
    resolved: NEW_SHA,
    status: "updated",
  });
});
