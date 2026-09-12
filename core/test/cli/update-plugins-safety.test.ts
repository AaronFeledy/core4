import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledPluginRegistry, recordInstalledPlugin } from "@lando/engine/plugins/installed-registry";
import { makePluginTrustStore } from "@lando/engine/plugins/trust-store";
import { ConfigService, PluginTrustStore } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { makePluginUpdateRunner } from "../../src/cli/commands/update-plugins";
import type { NpmRegistryClient } from "../../src/recipes/npm-source";

const roots: string[] = [];
const name = "review-plugin";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lando-update-safety-"));
  roots.push(root);
  const pluginsRoot = join(root, "plugins");
  const current = join(pluginsRoot, name, "1.0.0");
  const stage = join(root, "stage");
  const manifest = (version: string) =>
    JSON.stringify({
      name,
      version,
      landoPlugin: { name, version, api: 4, entry: "index.js", requires: { "@lando/core": "^4.0.0" } },
    });
  await mkdir(current, { recursive: true });
  await writeFile(join(current, "package.json"), manifest("1.0.0"));
  await writeFile(join(current, "index.js"), "export {};\n");
  await recordInstalledPlugin(pluginsRoot, {
    name,
    version: "1.0.0",
    path: current,
    requestedSelector: "latest",
  });
  await mkdir(join(stage, "package"), { recursive: true });
  await writeFile(join(stage, "package", "package.json"), manifest("1.1.0"));
  await writeFile(join(stage, "package", "index.js"), "export {};\n");
  const archive = join(root, "archive.tgz");
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", stage, "package"], { stdout: "pipe", stderr: "pipe" });
  expect(await tar.exited).toBe(0);
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
  const packument = {
    "dist-tags": { latest: "1.1.0" },
    versions: {
      "1.1.0": {
        name,
        version: "1.1.0",
        landoPlugin: { name, version: "1.1.0", requires: { "@lando/core": "^4.0.0" } },
        dist: {
          tarball: "https://fixture.invalid/plugin.tgz",
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        },
      },
    },
  };
  const trust = makePluginTrustStore(join(root, "trust.yml"));
  await Effect.runPromise(trust.trustPlugin(name));
  const layer = Layer.merge(
    Layer.succeed(PluginTrustStore, trust),
    Layer.succeed(ConfigService, {
      load: Effect.die("unused fixture config"),
      get: () => Effect.die("unused fixture config"),
    }),
  );
  const runner = (client: NpmRegistryClient) =>
    Effect.runPromise(
      makePluginUpdateRunner({
        userDataRoot: root,
        pluginsRoot,
        cacheRoot: join(root, "cache"),
        registryClient: client,
        fetcher: { fetch: async () => bytes },
      }).pipe(Effect.provide(layer)),
    );
  return { pluginsRoot, current, packument, runner };
}

const input = { currentCoreVersion: "4.1.0", targetCoreVersion: "4.2.0", combined: true, dryRun: false };

test("a stale updater retains the version activated by another updater", async () => {
  // Given: a second updater wins while the first resolves metadata.
  const f = await fixture();
  const winner = await f.runner({ fetchPackument: async () => f.packument });
  let completed = false;
  const stale = await f.runner({
    fetchPackument: async () => {
      if (!completed) {
        completed = true;
        expect((await Effect.runPromise(winner(input))).updatedPlugins).toEqual([name]);
      }
      return f.packument;
    },
  });
  // When: the stale updater applies.
  const result = await Effect.runPromise(stale(input));
  // Then: drift never deletes the winner's package.
  expect(result.rows[0]?.status).toBe("failed");
  const active = (await readInstalledPluginRegistry(f.pluginsRoot))[name];
  expect(active?.version).toBe("1.1.0");
  expect(await Bun.file(join(active?.path ?? "", "package.json")).exists()).toBe(true);
});
