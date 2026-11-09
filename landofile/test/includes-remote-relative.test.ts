import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { resolveAuthoredIncludes, updateAuthoredIncludes } from "./include-pipeline.ts";
import {
  gitDeps,
  makeNpmPackageTarball,
  makeTestLandofilePorts,
  makeTestLandofileStateStore,
  npmDeps,
  seedGitSourceEntry,
} from "./support.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-relative-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const options = () => {
  const cacheRoot = join(root, "cache");
  return {
    appRoot: root,
    cacheRoot,
    ports: makeTestLandofilePorts(cacheRoot),
    stateStore: makeTestLandofileStateStore(cacheRoot),
  };
};
const populate = async (dest: string, child = "./nested/child.yml") => {
  await mkdir(join(dest, "fragments", "nested"), { recursive: true });
  await Bun.write(join(dest, "fragments", "parent.yml"), `includes:\n  - ${child}\n`);
  await Bun.write(join(dest, "fragments", "nested", "child.yml"), "includes:\n  - ../leaf.yml\n");
  await Bun.write(join(dest, "fragments", "leaf.yml"), "services:\n  web:\n    type: php\n");
};

test("warm git symlink fragment keeps relative children inside its snapshot", async () => {
  const parent = "includes:\n  - ./child.yml\n";
  const child = "services:\n  web:\n    type: php\n";
  await seedGitSourceEntry(join(root, "cache"), SHA, {
    "parent.yml": parent,
    "child.yml": child,
    "fragments/parent.yml": parent, // will be replaced by symlink
  });
  // Replace fragments/parent.yml with symlink
  const snapshot = join(root, "cache", "sources", "git", SHA, "tree");
  await rm(join(snapshot, "fragments", "parent.yml"), { force: true });
  await mkdir(join(snapshot, "fragments"), { recursive: true });
  await symlink("../parent.yml", join(snapshot, "fragments", "parent.yml"));
  const entries = [
    { path: "fragments/parent.yml", version: "main", content: parent },
    { path: "child.yml", version: SHA, content: child },
  ];
  await Bun.write(
    join(root, ".lando.lock.yml"),
    `includes:\n${entries.map((entry) => `  - source: github:acme/shared/${entry.path}\n    version: ${entry.version}\n    resolved: ${SHA}\n    checksum: ${new Bun.CryptoHasher("sha256").update(entry.content).digest("hex")}\n`).join("")}`,
  );
  const loaded = await Effect.runPromise(
    resolveAuthoredIncludes({
      ...options(),
      landofile: {
        includes: [{ source: "github:acme/shared", path: "fragments/parent.yml", version: "main" }],
      },
    }),
  );
  expect(loaded.services?.[ServiceName.make("web")]?.type).toBe("php");
});

for (const indirect of [false, true]) {
  test(`git relative ${indirect ? "a-to-b-to-a" : "self"} include reports a cycle before selector conflict`, async () => {
    const input = {
      ...options(),
      landofile: { includes: [{ source: "github:acme/shared", path: "a.yml", version: "main" }] },
      deps: gitDeps({
        fetch: async ({ dest }) => {
          await Bun.write(join(dest, "a.yml"), `includes:\n  - ./${indirect ? "b" : "a"}.yml\n`);
          await Bun.write(join(dest, "b.yml"), "includes:\n  - ./a.yml\n");
          return { commit: SHA };
        },
      }),
    };
    const error = await Effect.runPromise(Effect.flip(resolveAuthoredIncludes(input)));
    expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "cycle" });
  });
}

for (const kind of ["git", "npm"] as const) {
  test(`${kind} relative descendants pin at the parent revision and load offline when warm`, async () => {
    const calls: Array<string | undefined> = [];
    const source = kind === "git" ? "github:acme/shared" : "npm:@acme/shared";
    const revision = kind === "git" ? SHA : "1.2.3";
    const tarball = makeNpmPackageTarball({
      "fragments/parent.yml": "includes:\n  - ./nested/child.yml\n",
      "fragments/nested/child.yml": "includes:\n  - ../leaf.yml\n",
      "fragments/leaf.yml": "services:\n  web:\n    type: php\n",
    });
    const registry = npmDeps({
      name: "@acme/shared",
      version: revision,
      tarball,
      tags: { main: revision },
      onPackument: () => calls.push(`@acme/shared@${revision}`),
    });
    const deps =
      kind === "git"
        ? gitDeps({
            fetch: async ({ dest, ref }) => {
              calls.push(ref);
              await populate(dest);
              return { commit: SHA };
            },
          })
        : registry;
    const base = options();
    const input = {
      ...base,
      ports: kind === "npm" ? makeTestLandofilePorts(base.cacheRoot, base.cacheRoot, registry) : base.ports,
      landofile: { includes: [{ source, path: "fragments/parent.yml", version: "main" }] },
      deps,
    };
    await Effect.runPromise(resolveAuthoredIncludes(input));
    const acquisitions = calls.length;
    // Offline warm reload: keep registry transport for index lookup, drop fetch activity via deps.
    const loaded = await Effect.runPromise(
      resolveAuthoredIncludes({
        ...input,
        deps: kind === "npm" ? registry : {},
      }),
    );
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
  });
}

for (const child of ["../../outside.yml", "/outside.yml"]) {
  test(`remote child rejects snapshot escape ${child}`, async () => {
    const input = {
      ...options(),
      landofile: { includes: [{ source: "github:acme/shared", path: "fragments/parent.yml" }] },
      deps: gitDeps({
        fetch: async ({ dest }) => {
          await populate(dest, child);
          return { commit: SHA };
        },
      }),
    };
    const error = await Effect.runPromise(Effect.flip(resolveAuthoredIncludes(input)));
    expect(error).toMatchObject({ _tag: "LandofileIncludeError", kind: "outside-root" });
    expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
  });
}

test("parent refresh moves descendant selectors to the refreshed revision", async () => {
  let revision = SHA;
  const input = {
    ...options(),
    landofile: {
      includes: [{ source: "github:acme/shared", path: "fragments/parent.yml", version: "main" }],
    },
    deps: gitDeps({
      fetch: async ({ dest }) => {
        await populate(dest);
        return { commit: revision };
      },
    }),
  };
  await Effect.runPromise(resolveAuthoredIncludes(input));
  revision = NEW_SHA;
  const report = await Effect.runPromise(updateAuthoredIncludes(input));
  expect(report.entries.find((entry) => entry.source.endsWith("/leaf.yml"))).toMatchObject({
    version: NEW_SHA,
    resolved: NEW_SHA,
  });
});
