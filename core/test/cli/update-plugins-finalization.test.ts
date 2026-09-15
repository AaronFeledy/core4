import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledPluginRegistry, recordInstalledPlugin } from "@lando/engine/plugins/installed-registry";
import { withPluginMutationLock } from "@lando/engine/plugins/mutation-lock";
import { makePluginTrustStore } from "@lando/engine/plugins/trust-store";
import { ConfigService, PluginTrustStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { makePluginUpdateRunner } from "../../src/cli/commands/update-plugins";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const name = "finalization-plugin";
const manifest = (version: string) => ({
  name,
  version,
  api: 4,
  entry: "index.js",
  requires: { "@lando/core": "^4.0.0" },
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lando-update-finalization-"));
  roots.push(root);
  const pluginsRoot = join(root, "plugins");
  const current = join(pluginsRoot, name, "1.0.0");
  await mkdir(current, { recursive: true });
  await writeFile(join(current, "package.json"), JSON.stringify({ landoPlugin: manifest("1.0.0") }));
  await writeFile(join(current, "index.js"), "export {};\n");
  await recordInstalledPlugin(pluginsRoot, {
    name,
    version: "1.0.0",
    path: current,
    requestedSelector: "latest",
  });
  const trust = makePluginTrustStore(join(root, "trust.yml"));
  await Effect.runPromise(trust.trustPlugin(name));
  const bytes = new TextEncoder().encode("integrity-checked fixture archive");
  const layer = Layer.merge(
    Layer.succeed(PluginTrustStore, trust),
    Layer.succeed(ConfigService, {
      load: Effect.die("unused fixture config"),
      get: () => Effect.die("unused fixture config"),
    }),
  );
  const run = async (lifecycle: (cwd: string) => Promise<void>) => {
    const runner = await Effect.runPromise(
      makePluginUpdateRunner({
        userDataRoot: root,
        pluginsRoot,
        cacheRoot: join(root, "cache"),
        registryClient: {
          fetchPackument: async () => ({
            "dist-tags": { latest: "1.1.0" },
            versions: {
              "1.1.0": {
                name,
                version: "1.1.0",
                landoPlugin: manifest("1.1.0"),
                dist: {
                  tarball: "https://fixture.invalid/plugin.tgz",
                  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                },
              },
            },
          }),
        },
        fetcher: { fetch: async () => bytes },
        extractor: {
          extract: async (_bytes, destination) => {
            const pkg = join(destination, "package");
            await mkdir(pkg, { recursive: true });
            await writeFile(
              join(pkg, "package.json"),
              JSON.stringify({
                scripts: { postinstall: "fixture" },
                landoPlugin: manifest("1.1.0"),
              }),
            );
            await writeFile(join(pkg, "index.js"), "export {};\n");
          },
        },
        bunSelfSpawner: {
          spawn: async (request) => {
            await lifecycle(request.cwd);
            return { exitCode: 0 };
          },
        },
      }).pipe(Effect.provide(layer)),
    );
    return Effect.runPromise(
      runner({
        currentCoreVersion: "4.1.0",
        targetCoreVersion: "4.1.0",
        combined: false,
        dryRun: false,
      }),
    );
  };
  return { root, pluginsRoot, current, trust, run };
}

test("lifecycle can acquire the mutation lock before the finalizer publishes", async () => {
  // Given: a lifecycle command needs the same registry mutation lock.
  const f = await fixture();
  let nestedCompleted = false;
  // When: lifecycle runs during a staged update.
  const result = await f.run(async () => {
    await Effect.runPromise(
      withPluginMutationLock(
        f.pluginsRoot,
        "fixture:nested",
        Effect.sync(() => {
          nestedCompleted = true;
        }),
      ).pipe(Effect.timeout("250 millis")),
    );
  });
  // Then: it completes without waiting on its own parent, and activation succeeds.
  expect(nestedCompleted).toBe(true);
  expect(result.updatedPlugins).toEqual([name]);
});

test.each(["trust", "manifest", "other-entry"] as const)(
  "rejects %s drift during lifecycle without publishing or deleting prior bytes",
  async (drift) => {
    // Given: an authorized candidate and immutable prior package.
    const f = await fixture();
    const before = await readFile(join(f.current, "package.json"));
    // When: lifecycle changes a finalization precondition.
    const result = await f.run(async (cwd) => {
      switch (drift) {
        case "trust":
          await Effect.runPromise(f.trust.untrustPlugin(name));
          break;
        case "manifest":
          await writeFile(
            join(cwd, "package.json"),
            JSON.stringify({
              landoPlugin: {
                ...manifest("1.1.0"),
                requires: { "@lando/core": ">=5" },
              },
            }),
          );
          break;
        case "other-entry":
          await recordInstalledPlugin(f.pluginsRoot, {
            name: "concurrent",
            version: "1.0.0",
            path: join(f.root, "concurrent"),
            requestedSelector: "1.0.0",
          });
          break;
      }
    });
    // Then: the stale update fails, with only its staging directory cleaned up.
    expect(result.updatedPlugins).toEqual([]);
    expect(result.rows).toMatchObject([{ status: "failed" }]);
    expect((await readInstalledPluginRegistry(f.pluginsRoot))[name]?.version).toBe("1.0.0");
    expect(await readFile(join(f.current, "package.json"))).toEqual(before);
    expect(await readdir(join(f.pluginsRoot, name))).toEqual(["1.0.0"]);
  },
);
