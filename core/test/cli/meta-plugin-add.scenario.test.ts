import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { pluginAdd } from "../../src/cli/commands/plugin-add.ts";
import type { NpmPackument, NpmRegistryClient } from "../../src/recipes/npm-source.ts";
import type { TarballRecipeFetcher } from "../../src/recipes/tarball-source.ts";

let userDataRoot: string;
let pluginsRoot: string;

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

const writePluginManifest = async (
  packageDir: string,
  manifest: { name: string; version: string; main?: string; landoPlugin?: Record<string, unknown> },
) => {
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      ...(manifest.main === undefined ? {} : { main: manifest.main }),
      landoPlugin: manifest.landoPlugin ?? {
        name: manifest.name,
        version: manifest.version,
        api: 4,
        entry: "index.js",
      },
    }),
  );
  await writeFile(join(packageDir, "index.js"), "module.exports = {};\n");
};

const makeNpmTarball = async (files: Readonly<Record<string, string>>): Promise<Uint8Array> => {
  const stage = await mkdtemp(join(tmpdir(), "lando-plugin-add-tar-"));
  const pkg = join(stage, "package");
  const out = join(stage, "archive.tgz");
  try {
    await mkdir(pkg, { recursive: true });
    for (const [rel, fileContent] of Object.entries(files)) {
      const target = join(pkg, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, fileContent);
    }
    const proc = Bun.spawn({
      cmd: ["tar", "-czf", out, "-C", stage, "package"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`tar failed: ${stderr}`);
    return new Uint8Array(await Bun.file(out).arrayBuffer());
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};

const sha512Sri = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const packumentFor = (packageName: string, bytes: Uint8Array, version = "1.2.3"): NpmPackument => ({
  "dist-tags": { latest: version },
  versions: {
    [version]: {
      dist: {
        tarball: `https://registry.example/${packageName}/-/${packageName.split("/").pop()}-${version}.tgz`,
        integrity: sha512Sri(bytes),
      },
    },
  },
});

const clientFor = (packument: NpmPackument | undefined, calls?: Array<string>): NpmRegistryClient => ({
  fetchPackument: async (name) => {
    calls?.push(name);
    return packument;
  },
});

const fetcherFor = (bytes: Uint8Array, calls?: Array<string>): TarballRecipeFetcher => ({
  fetch: async (url) => {
    calls?.push(url);
    return bytes;
  },
});

const pluginPackageJson = (name: string, version: string, landoPlugin: Record<string, unknown> = {}) =>
  JSON.stringify({
    name,
    version,
    landoPlugin: {
      name,
      version,
      api: 4,
      entry: "index.js",
      ...landoPlugin,
    },
  });

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  userDataRoot = await mkdtemp(join(tmpdir(), "lando-plugin-add-"));
  pluginsRoot = join(userDataRoot, "plugins");
});

afterEach(async () => {
  if (userDataRoot !== undefined) await rm(userDataRoot, { recursive: true, force: true });
});

describe("meta:plugin:add command", () => {
  test("downloads an npm tarball, validates the manifest, and installs under plugins/<name>/<version>", async () => {
    const bytes = await makeNpmTarball({
      "package.json": pluginPackageJson("@lando/plugin-php", "1.2.3"),
      "index.js": "export {};\n",
    });
    const registryCalls: Array<string> = [];
    const fetchCalls: Array<string> = [];
    const trustStore = new Set<string>();
    const result = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: true,
        registryClient: clientFor(packumentFor("@lando/plugin-php", bytes), registryCalls),
        fetcher: fetcherFor(bytes, fetchCalls),
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(result.pluginName).toBe("@lando/plugin-php");
    expect(result.pluginVersion).toBe("1.2.3");
    expect(result.entry).toBe(join(pluginsRoot, "@lando/plugin-php", "1.2.3"));
    expect(await exists(join(result.entry, "package.json"))).toBe(true);
    expect(registryCalls).toEqual(["@lando/plugin-php"]);
    expect(fetchCalls).toHaveLength(1);
    expect(trustStore.has("@lando/plugin-php")).toBe(true);
  });

  test("removes a newly unpacked npm plugin when registry recording cannot write", async () => {
    const bytes = await makeNpmTarball({
      "package.json": pluginPackageJson("@lando/plugin-php", "1.2.3"),
      "index.js": "export {};\n",
    });
    await mkdir(join(pluginsRoot, "registry.json.tmp"), { recursive: true });

    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: true,
        registryClient: clientFor(packumentFor("@lando/plugin-php", bytes)),
        fetcher: fetcherFor(bytes),
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(await exists(join(pluginsRoot, "@lando/plugin-php", "1.2.3"))).toBe(false);
  });

  test("rewrites npm recipe-source remediation for plugin add", async () => {
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: true,
        registryClient: clientFor({
          "dist-tags": {},
          versions: {},
        }),
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("NotImplementedError");
      expect(cause).toContain("lando plugin:add @lando/plugin-php");
      expect(cause).not.toContain("--package=");
      expect(cause).not.toContain("lando init");
    }
  });

  test("fails closed when npm metadata omits the tarball URL", async () => {
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: true,
        registryClient: clientFor({
          "dist-tags": { latest: "1.2.3" },
          versions: {
            "1.2.3": {
              dist: {
                integrity: "sha512-test",
              },
            },
          },
        } as NpmPackument),
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("has no published tarball URL");
      expect(cause).not.toContain("TypeError");
    }
  });

  test("supports exact version pins and re-runs idempotently without re-downloading an installed version", async () => {
    const bytes = await makeNpmTarball({
      "package.json": pluginPackageJson("@lando/plugin-php", "2.0.0"),
      "index.js": "export {};\n",
    });
    const registryCalls: Array<string> = [];
    const fetchCalls: Array<string> = [];
    const trustStore = new Set<string>();
    const common = {
      spec: "@lando/plugin-php@2.0.0",
      trust: true,
      registryClient: clientFor(packumentFor("@lando/plugin-php", bytes, "2.0.0"), registryCalls),
      fetcher: fetcherFor(bytes, fetchCalls),
      trustStore,
    } as const;

    const first = await Effect.runPromise(
      pluginAdd(common).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    const second = await Effect.runPromise(
      pluginAdd(common).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(first.entry).toBe(join(pluginsRoot, "@lando/plugin-php", "2.0.0"));
    expect(second.entry).toBe(first.entry);
    expect(registryCalls).toEqual(["@lando/plugin-php", "@lando/plugin-php"]);
    expect(fetchCalls).toHaveLength(1);
    expect(second.trustSource).toBe("session");
  });

  test("fails closed when a downloaded package manifest is invalid", async () => {
    const bytes = await makeNpmTarball({
      "package.json": JSON.stringify({
        name: "@lando/plugin-bad",
        version: "0.0.1",
        landoPlugin: { name: "bad" },
      }),
      "index.js": "export {};\n",
    });
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-bad",
        trust: true,
        registryClient: clientFor(packumentFor("@lando/plugin-bad", bytes, "0.0.1")),
        fetcher: fetcherFor(bytes),
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginManifestError");
      expect(await exists(join(pluginsRoot, "@lando/plugin-bad", "0.0.1"))).toBe(false);
    }
  });

  test("rejects registry metadata that resolves outside the plugin root before downloading", async () => {
    const bytes = await makeNpmTarball({
      "package.json": pluginPackageJson("@lando/plugin-escape", "../../../escape"),
      "index.js": "export {};\n",
    });
    let fetchCalls = 0;
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-escape",
        trust: true,
        registryClient: clientFor({
          "dist-tags": { latest: "../../../escape" },
          versions: {
            "../../../escape": {
              dist: {
                tarball: "https://registry.example/escape.tgz",
                integrity: sha512Sri(bytes),
              },
            },
          },
        }),
        fetcher: {
          fetch: async () => {
            fetchCalls += 1;
            return bytes;
          },
        },
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(fetchCalls).toBe(0);
    expect(await exists(join(userDataRoot, "escape"))).toBe(false);
  });

  test("cleans staging content when extraction fails before publication", async () => {
    const bytes = await makeNpmTarball({
      "package.json": pluginPackageJson("@lando/plugin-partial", "1.0.0"),
      "index.js": "export {};\n",
    });
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-partial@1.0.0",
        trust: true,
        registryClient: clientFor(packumentFor("@lando/plugin-partial", bytes, "1.0.0")),
        fetcher: fetcherFor(bytes),
        extractor: {
          extract: async (_archiveBytes, destDir) => {
            await writeFile(join(destDir, "leaked.txt"), "partial");
            throw new Error("extract failed after writing");
          },
        },
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );

    expect(exit._tag).toBe("Failure");
    expect(await exists(join(pluginsRoot, "@lando/plugin-partial", "1.0.0"))).toBe(false);
    expect(await exists(join(pluginsRoot, "@lando/plugin-partial", ".staging"))).toBe(false);
  });

  test("installs a plugin via the BunSelfRunner and validates the manifest before recording trust", async () => {
    const calls: Array<{ spec: string; cwd: string }> = [];
    const spawner = {
      install: async ({ spec, cwd }: { spec: string; cwd: string }) => {
        calls.push({ spec, cwd });
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-php"), {
          name: "@lando/plugin-php",
          version: "1.2.3",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-php") };
      },
    };
    const trustStore = new Set<string>();
    const result = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: true,
        spawner,
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(result.pluginName).toBe("@lando/plugin-php");
    expect(result.pluginVersion).toBe("1.2.3");
    expect(result.trusted).toBe(true);
    expect(result.trustSource).toBe("flag");
    expect(trustStore.has("@lando/plugin-php")).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.cwd).toBe(pluginsRoot);
  });

  test("fails closed when the manifest cannot be validated", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        const packageDir = join(cwd, "node_modules", "@lando/plugin-bad");
        await mkdir(packageDir, { recursive: true });
        await writeFile(
          join(packageDir, "package.json"),
          JSON.stringify({ name: "@lando/plugin-bad", version: "0.0.1", landoPlugin: { name: "bad" } }),
        );
        return { exitCode: 0, stderr: "", packageRoot: packageDir };
      },
    };
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-bad",
        trust: true,
        spawner,
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginManifestError");
    }
  });

  test("rejects manifests whose entry escapes the package directory", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        const packageDir = join(cwd, "node_modules", "@lando/plugin-escape");
        await mkdir(packageDir, { recursive: true });
        await writeFile(
          join(packageDir, "package.json"),
          JSON.stringify({
            name: "@lando/plugin-escape",
            version: "0.0.1",
            landoPlugin: {
              name: "@lando/plugin-escape",
              version: "0.0.1",
              api: 4,
              entry: "../../../escape.js",
            },
          }),
        );
        return { exitCode: 0, stderr: "", packageRoot: packageDir };
      },
    };
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-escape",
        trust: true,
        spawner,
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("PluginManifestError");
      expect(cause).toContain("entry");
    }
  });

  test("non-interactive run without --trust returns structured remediation", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-php"), {
          name: "@lando/plugin-php",
          version: "1.0.0",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-php") };
      },
    };
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-php",
        trust: false,
        nonInteractive: true,
        spawner,
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("NotImplementedError");
      expect(cause).toContain("--trust");
    }
  });

  test("prompt-confirmed trust persists to the in-memory store for the current install session", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-prompt"), {
          name: "@lando/plugin-prompt",
          version: "0.1.0",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-prompt") };
      },
    };
    let promptCalls = 0;
    const prompter = {
      confirmTrust: async () => {
        promptCalls += 1;
        return true;
      },
    };
    const trustStore = new Set<string>();
    const first = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-prompt",
        spawner,
        prompter,
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(first.trustSource).toBe("prompt");
    expect(promptCalls).toBe(1);
    expect(trustStore.has("@lando/plugin-prompt")).toBe(true);

    const second = await Effect.runPromise(
      pluginAdd({
        spec: "@lando/plugin-prompt",
        spawner,
        prompter,
        trustStore,
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(second.trustSource).toBe("session");
    expect(promptCalls).toBe(1);
  });

  test("declining the prompt returns structured remediation", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-decline"), {
          name: "@lando/plugin-decline",
          version: "0.1.0",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-decline") };
      },
    };
    const prompter = { confirmTrust: async () => false };
    const exit = await Effect.runPromiseExit(
      pluginAdd({
        spec: "@lando/plugin-decline",
        spawner,
        prompter,
        trustStore: new Set<string>(),
      }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = JSON.stringify(exit.cause);
      expect(cause).toContain("declined");
    }
  });

  test("uses a fresh trust store per install", async () => {
    const spawner = {
      install: async ({ cwd }: { spec: string; cwd: string }) => {
        await writePluginManifest(join(cwd, "node_modules", "@lando/plugin-isolation"), {
          name: "@lando/plugin-isolation",
          version: "0.0.1",
        });
        return { exitCode: 0, stderr: "", packageRoot: join(cwd, "node_modules", "@lando/plugin-isolation") };
      },
    };
    let promptCalls = 0;
    const prompter = {
      confirmTrust: async () => {
        promptCalls += 1;
        return true;
      },
    };

    const altUserConfRoot = await mkdtemp(join(tmpdir(), "lando-trust-isolation-"));
    try {
      const result = await Effect.runPromise(
        pluginAdd({
          spec: "@lando/plugin-isolation",
          spawner,
          prompter,
          trustStore: new Set<string>(),
        }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
      );
      expect(result.trustSource).toBe("prompt");
      expect(promptCalls).toBe(1);
    } finally {
      await rm(altUserConfRoot, { recursive: true, force: true });
    }
  });
});
