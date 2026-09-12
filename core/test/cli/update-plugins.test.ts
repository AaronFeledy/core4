import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makePluginTrustStore } from "@lando/engine/plugins/trust-store";
import { ConfigService, PluginTrustStore } from "@lando/sdk/services";
import { makePluginUpdateRunner } from "../../src/cli/commands/update-plugins.ts";
import type { NpmPackument, NpmRegistryClient } from "../../src/recipes/npm-source.ts";
import type { TarballRecipeFetcher } from "../../src/recipes/tarball-source.ts";

let root: string;
let pluginsRoot: string;

const pluginManifest = (name: string, version: string): string =>
  JSON.stringify({
    name,
    version,
    landoPlugin: {
      name,
      version,
      api: 4,
      entry: "index.js",
      requires: { "@lando/core": "^4.0.0" },
    },
  });

const makeTarball = async (name: string, version: string): Promise<Uint8Array> => {
  const stage = await mkdtemp(join(tmpdir(), "lando-update-plugin-tar-"));
  const pkg = join(stage, "package");
  const archive = join(stage, "archive.tgz");
  try {
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), pluginManifest(name, version));
    await writeFile(join(pkg, "index.js"), "export {};\n");
    const proc = Bun.spawn({
      cmd: ["tar", "-czf", archive, "-C", stage, "package"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (exitCode !== 0) throw new Error(`tar failed: ${stderr}`);
    return new Uint8Array(await Bun.file(archive).arrayBuffer());
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

const layerFor = (trustStore: typeof PluginTrustStore.Service) =>
  Layer.merge(
    Layer.succeed(ConfigService, {
      get: <K extends string>(key: K) =>
        Effect.succeed(key === "userDataRoot" ? (root as never) : (undefined as never)),
      getEffective: () => Effect.succeed({} as never),
    } as never),
    Layer.succeed(PluginTrustStore, trustStore),
  );

const packumentFor = (
  name: string,
  bytes: Uint8Array,
  requires: Readonly<Record<string, string>> = { "@lando/core": "^4.0.0" },
): NpmPackument => ({
  "dist-tags": { latest: "1.1.0" },
  versions: {
    "1.1.0": {
      name,
      version: "1.1.0",
      landoPlugin: { name, version: "1.1.0", requires },
      dist: {
        tarball: `https://registry.example/${name}/1.1.0.tgz`,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      },
    },
  },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-update-plugins-"));
  pluginsRoot = join(root, "plugins");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("registry plugin update adapter", () => {
  test("dry-run plans an update without fetching its tarball or mutating persistent state", async () => {
    const name = "@lando/plugin-php";
    const currentPath = join(pluginsRoot, name, "1.0.0");
    await mkdir(currentPath, { recursive: true });
    await writeFile(join(currentPath, "package.json"), pluginManifest(name, "1.0.0"));
    await writeFile(join(currentPath, "index.js"), "export {};\n");
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({ [name]: { name, version: "1.0.0", path: currentPath, requestedSelector: "latest" } })}\n`,
    );
    const trustStore = makePluginTrustStore(join(root, "trust.yml"));
    await Effect.runPromise(trustStore.trustPlugin(name));
    const bytes = await makeTarball(name, "1.1.0");
    const tarballCalls: string[] = [];
    const registryClient: NpmRegistryClient = { fetchPackument: async () => packumentFor(name, bytes) };
    const fetcher: TarballRecipeFetcher = {
      fetch: async (url) => {
        tarballCalls.push(url);
        return bytes;
      },
    };
    const before = await readFile(join(pluginsRoot, "registry.json"), "utf8");
    const runner = await Effect.runPromise(
      makePluginUpdateRunner({ pluginsRoot, registryClient, fetcher }).pipe(
        Effect.provide(layerFor(trustStore)),
      ),
    );

    const result = await Effect.runPromise(
      runner({ currentCoreVersion: "4.1.0", targetCoreVersion: "4.2.0", combined: true, dryRun: true }),
    );

    expect(result.rows).toMatchObject([{ name, status: "update", targetVersion: "1.1.0" }]);
    expect(tarballCalls).toEqual([]);
    expect(await readFile(join(pluginsRoot, "registry.json"), "utf8")).toBe(before);
  });

  test("applies an integrity-verified update and preserves the floating selector and prior version", async () => {
    const name = "@lando/plugin-php";
    const currentPath = join(pluginsRoot, name, "1.0.0");
    await mkdir(currentPath, { recursive: true });
    await writeFile(join(currentPath, "package.json"), pluginManifest(name, "1.0.0"));
    await writeFile(join(currentPath, "index.js"), "export {};\n");
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({ [name]: { name, version: "1.0.0", path: currentPath, requestedSelector: "latest" } })}\n`,
    );
    const trustStore = makePluginTrustStore(join(root, "trust.yml"));
    await Effect.runPromise(trustStore.trustPlugin(name));
    const bytes = await makeTarball(name, "1.1.0");
    const registryClient: NpmRegistryClient = { fetchPackument: async () => packumentFor(name, bytes) };
    const fetcher: TarballRecipeFetcher = { fetch: async () => bytes };
    const runner = await Effect.runPromise(
      makePluginUpdateRunner({ pluginsRoot, registryClient, fetcher }).pipe(
        Effect.provide(layerFor(trustStore)),
      ),
    );

    const result = await Effect.runPromise(
      runner({ currentCoreVersion: "4.1.0", targetCoreVersion: "4.1.0", combined: false, dryRun: false }),
    );

    const registry = JSON.parse(await readFile(join(pluginsRoot, "registry.json"), "utf8"));
    expect(result.updatedPlugins).toEqual([name]);
    expect(registry[name]).toMatchObject({ version: "1.1.0", requestedSelector: "latest" });
    expect(await readFile(join(currentPath, "package.json"), "utf8")).toContain("1.0.0");
  });

  test("blocks a combined core update when a required plugin update fails", async () => {
    // Given
    const name = "@lando/plugin-php";
    const currentPath = join(pluginsRoot, name, "1.0.0");
    await mkdir(currentPath, { recursive: true });
    await writeFile(join(currentPath, "package.json"), pluginManifest(name, "1.0.0"));
    await writeFile(join(currentPath, "index.js"), "export {};\n");
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({ [name]: { name, version: "1.0.0", path: currentPath, requestedSelector: "latest" } })}\n`,
    );
    const trustStore = makePluginTrustStore(join(root, "trust.yml"));
    await Effect.runPromise(trustStore.trustPlugin(name));
    const bytes = await makeTarball(name, "1.1.0");
    const registryClient: NpmRegistryClient = {
      fetchPackument: async () => packumentFor(name, bytes, { "@lando/core": ">=4 <6" }),
    };
    const fetcher: TarballRecipeFetcher = {
      fetch: () => Promise.reject(new Error("fixture download failure")),
    };
    const runner = await Effect.runPromise(
      makePluginUpdateRunner({ pluginsRoot, registryClient, fetcher }).pipe(
        Effect.provide(layerFor(trustStore)),
      ),
    );

    // When
    const result = await Effect.runPromise(
      runner({ currentCoreVersion: "4.1.0", targetCoreVersion: "5.0.0", combined: true, dryRun: false }),
    );

    // Then
    expect(result.rows).toMatchObject([{ name, status: "failed", reason: "apply-failed" }]);
    expect(result.updatedPlugins).toEqual([]);
    expect(result.blockCore).toBe(true);
  });

  test("fails a row without overwriting registry drift after planning", async () => {
    // Given
    const name = "@lando/plugin-php";
    const currentPath = join(pluginsRoot, name, "1.0.0");
    const driftedPath = join(pluginsRoot, name, "1.0.1");
    await mkdir(currentPath, { recursive: true });
    await mkdir(driftedPath, { recursive: true });
    await writeFile(join(currentPath, "package.json"), pluginManifest(name, "1.0.0"));
    await writeFile(join(currentPath, "index.js"), "export {};\n");
    await writeFile(join(driftedPath, "package.json"), pluginManifest(name, "1.0.1"));
    await writeFile(join(driftedPath, "index.js"), "export {};\n");
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({ [name]: { name, version: "1.0.0", path: currentPath, requestedSelector: "latest" } })}\n`,
    );
    const trustStore = makePluginTrustStore(join(root, "trust.yml"));
    await Effect.runPromise(trustStore.trustPlugin(name));
    const bytes = await makeTarball(name, "1.1.0");
    const registryClient: NpmRegistryClient = { fetchPackument: async () => packumentFor(name, bytes) };
    const fetcher: TarballRecipeFetcher = {
      fetch: async () => {
        await writeFile(
          join(pluginsRoot, "registry.json"),
          `${JSON.stringify({ [name]: { name, version: "1.0.1", path: driftedPath, requestedSelector: "latest" } })}\n`,
        );
        return bytes;
      },
    };
    const runner = await Effect.runPromise(
      makePluginUpdateRunner({ pluginsRoot, registryClient, fetcher }).pipe(
        Effect.provide(layerFor(trustStore)),
      ),
    );

    // When
    const result = await Effect.runPromise(
      runner({ currentCoreVersion: "4.1.0", targetCoreVersion: "4.1.0", combined: false, dryRun: false }),
    );

    // Then
    const registry = JSON.parse(await readFile(join(pluginsRoot, "registry.json"), "utf8"));
    expect(result.rows).toMatchObject([{ name, status: "failed", reason: "apply-failed" }]);
    expect(result.updatedPlugins).toEqual([]);
    expect(registry[name]).toMatchObject({ version: "1.0.1", path: driftedPath });
    await expect(Bun.file(join(pluginsRoot, name, "1.1.0", "package.json")).exists()).resolves.toBe(false);
  });

  test("does not apply after persistent trust is revoked during planning", async () => {
    // Given
    const name = "@lando/plugin-php";
    const currentPath = join(pluginsRoot, name, "1.0.0");
    await mkdir(currentPath, { recursive: true });
    await writeFile(join(currentPath, "package.json"), pluginManifest(name, "1.0.0"));
    await writeFile(join(currentPath, "index.js"), "export {};\n");
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({ [name]: { name, version: "1.0.0", path: currentPath, requestedSelector: "latest" } })}\n`,
    );
    const trustStore = makePluginTrustStore(join(root, "trust.yml"));
    await Effect.runPromise(trustStore.trustPlugin(name));
    const bytes = await makeTarball(name, "1.1.0");
    const registryClient: NpmRegistryClient = {
      fetchPackument: async () => {
        await Effect.runPromise(trustStore.untrustPlugin(name));
        return packumentFor(name, bytes);
      },
    };
    const runner = await Effect.runPromise(
      makePluginUpdateRunner({ pluginsRoot, registryClient, fetcher: { fetch: async () => bytes } }).pipe(
        Effect.provide(layerFor(trustStore)),
      ),
    );

    // When
    const result = await Effect.runPromise(
      runner({ currentCoreVersion: "4.1.0", targetCoreVersion: "4.1.0", combined: false, dryRun: false }),
    );

    // Then
    expect(result.rows).toMatchObject([{ name, status: "failed", reason: "apply-failed" }]);
    expect(result.updatedPlugins).toEqual([]);
  });

  test("replaces an existing target directory from a freshly verified tarball", async () => {
    // Given
    const name = "@lando/plugin-php";
    const currentPath = join(pluginsRoot, name, "1.0.0");
    const targetPath = join(pluginsRoot, name, "1.1.0");
    await mkdir(currentPath, { recursive: true });
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(currentPath, "package.json"), pluginManifest(name, "1.0.0"));
    await writeFile(join(currentPath, "index.js"), "export {};\n");
    await writeFile(join(targetPath, "package.json"), pluginManifest(name, "1.1.0"));
    await writeFile(join(targetPath, "index.js"), "malicious();\n");
    await writeFile(
      join(pluginsRoot, "registry.json"),
      `${JSON.stringify({ [name]: { name, version: "1.0.0", path: currentPath, requestedSelector: "latest" } })}\n`,
    );
    const trustStore = makePluginTrustStore(join(root, "trust.yml"));
    await Effect.runPromise(trustStore.trustPlugin(name));
    const bytes = await makeTarball(name, "1.1.0");
    const tarballCalls: string[] = [];
    const registryClient: NpmRegistryClient = { fetchPackument: async () => packumentFor(name, bytes) };
    const runner = await Effect.runPromise(
      makePluginUpdateRunner({
        pluginsRoot,
        registryClient,
        fetcher: {
          fetch: async (url) => {
            tarballCalls.push(url);
            return bytes;
          },
        },
      }).pipe(Effect.provide(layerFor(trustStore))),
    );

    // When
    const result = await Effect.runPromise(
      runner({ currentCoreVersion: "4.1.0", targetCoreVersion: "4.1.0", combined: false, dryRun: false }),
    );

    // Then
    expect(result.updatedPlugins).toEqual([name]);
    expect(tarballCalls).toHaveLength(1);
    expect(await readFile(join(targetPath, "index.js"), "utf8")).toBe("export {};\n");
  });
});
