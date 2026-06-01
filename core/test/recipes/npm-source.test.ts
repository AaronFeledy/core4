import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { RecipeSourceError } from "@lando/sdk/errors";
import { RecipeManifestService } from "@lando/sdk/services";

import { initApp } from "../../src/cli/commands/init.ts";
import { RecipeManifestServiceLive } from "../../src/recipes/manifest/service.ts";
import {
  type NpmPackument,
  type NpmRegistryClient,
  parseNpmPackageSpec,
  resolveNpmRecipeSource,
} from "../../src/recipes/npm-source.ts";
import type { TarballRecipeFetcher } from "../../src/recipes/tarball-source.ts";

const VALID_RECIPE = `id: npm-recipe
title: Npm Recipe
description: An npm sourced recipe.
version: 0.1.0
prompts:
  - name: name
    type: text
    message: App name
    default: npm-app
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-npm-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Build a real npm-style `.tgz` whose entries are nested under the conventional
 * `package/` prefix (this is exactly how `npm pack` lays out a published
 * tarball). Keys are paths INSIDE the package (e.g. `recipe.yml`).
 */
const makeNpmTarball = async (files: Readonly<Record<string, string>>): Promise<Uint8Array> => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), "lando-npm-build-")));
  const pkg = join(stage, "package");
  const out = join(stage, "archive.tgz");
  try {
    await mkdir(pkg, { recursive: true });
    for (const [rel, fileContent] of Object.entries(files)) {
      const target = join(pkg, rel);
      await mkdir(join(target, ".."), { recursive: true });
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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sha512Sri = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const sha1Hex = (bytes: Uint8Array): string => createHash("sha1").update(bytes).digest("hex");

const TARBALL_URL = "https://registry.npmjs.org/@lando/recipe-foo/-/recipe-foo-1.2.3.tgz";

const packumentFor = (
  bytes: Uint8Array,
  overrides?: {
    readonly distTags?: Readonly<Record<string, string>>;
    readonly versions?: Readonly<
      Record<string, { dist: { tarball: string; integrity?: string; shasum?: string } }>
    >;
    readonly integrity?: string;
    readonly shasum?: string;
  },
): NpmPackument => ({
  "dist-tags": overrides?.distTags ?? { latest: "1.2.3" },
  versions: overrides?.versions ?? {
    "1.2.3": {
      dist: {
        tarball: TARBALL_URL,
        ...(overrides?.integrity === undefined
          ? { integrity: sha512Sri(bytes) }
          : { integrity: overrides.integrity }),
        ...(overrides?.shasum === undefined ? {} : { shasum: overrides.shasum }),
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

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

describe("parseNpmPackageSpec", () => {
  test.each([
    ["@lando/recipe-foo@1.2.3", "@lando/recipe-foo", "1.2.3"],
    ["@lando/recipe-foo", "@lando/recipe-foo", undefined],
    ["recipe-foo@2.0.0", "recipe-foo", "2.0.0"],
    ["recipe-foo", "recipe-foo", undefined],
    ["@scope/pkg@next", "@scope/pkg", "next"],
  ])("parses %s", (spec, name, version) => {
    expect(parseNpmPackageSpec(spec)).toEqual({ name, ...(version === undefined ? {} : { version }) });
  });

  test.each(["", "   ", "@"])("rejects empty/invalid spec %p", (spec) => {
    expect(() => parseNpmPackageSpec(spec)).toThrow(RecipeSourceError);
  });
});

describe("resolveNpmRecipeSource", () => {
  test("resolves latest, downloads the published tarball, and extracts the package/ root", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const clientCalls: Array<string> = [];
      const fetchCalls: Array<string> = [];
      const userDataRoot = join(dir, "data");
      const result = await resolveNpmRecipeSource({
        package: "@lando/recipe-foo",
        userDataRoot,
        registryClient: clientFor(packumentFor(bytes), clientCalls),
        fetcher: fetcherFor(bytes, fetchCalls),
      });

      expect(clientCalls).toEqual(["@lando/recipe-foo"]);
      expect(fetchCalls).toEqual([TARBALL_URL]);
      expect(result.packageName).toBe("@lando/recipe-foo");
      expect(result.version).toBe("1.2.3");
      // Reuses the tarball extractor → cached under recipe-cache/tarball/<sha256>/package
      expect(result.root).toBe(join(userDataRoot, "recipe-cache", "tarball", sha256(bytes), "package"));
      expect(result.source).toBe(join(result.root, "recipe.yml"));
      expect(await Bun.file(result.source).exists()).toBe(true);
      const manifest = await Effect.runPromise(
        Effect.flatMap(RecipeManifestService, (svc) => svc.parse(result.source, result.manifestYaml)).pipe(
          Effect.provide(RecipeManifestServiceLive),
        ),
      );
      expect(manifest.id).toBe("npm-recipe");
    });
  });

  test("honors an exact @version suffix", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const result = await resolveNpmRecipeSource({
        package: "@lando/recipe-foo@1.2.3",
        userDataRoot: join(dir, "data"),
        registryClient: clientFor(packumentFor(bytes, { distTags: { latest: "9.9.9" } })),
        fetcher: fetcherFor(bytes),
      });
      expect(result.version).toBe("1.2.3");
    });
  });

  test("honors a dist-tag @version suffix", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const result = await resolveNpmRecipeSource({
        package: "@lando/recipe-foo@beta",
        userDataRoot: join(dir, "data"),
        registryClient: clientFor(packumentFor(bytes, { distTags: { latest: "9.9.9", beta: "1.2.3" } })),
        fetcher: fetcherFor(bytes),
      });
      expect(result.version).toBe("1.2.3");
    });
  });

  test("a sha512 integrity match passes", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const result = await resolveNpmRecipeSource({
        package: "@lando/recipe-foo",
        userDataRoot: join(dir, "data"),
        registryClient: clientFor(packumentFor(bytes, { integrity: sha512Sri(bytes) })),
        fetcher: fetcherFor(bytes),
      });
      expect(result.version).toBe("1.2.3");
    });
  });

  test("a sha1 shasum match passes when integrity is absent", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const result = await resolveNpmRecipeSource({
        package: "@lando/recipe-foo",
        userDataRoot: join(dir, "data"),
        registryClient: clientFor(
          packumentFor(bytes, {
            versions: { "1.2.3": { dist: { tarball: TARBALL_URL, shasum: sha1Hex(bytes) } } },
          }),
        ),
        fetcher: fetcherFor(bytes),
      });
      expect(result.version).toBe("1.2.3");
    });
  });

  test("an unusable integrity value falls back to sha1 shasum verification", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveNpmRecipeSource({
              package: "@lando/recipe-foo",
              userDataRoot: join(dir, "data"),
              registryClient: clientFor(
                packumentFor(bytes, { integrity: "sha999-not-a-supported-sri", shasum: "0".repeat(40) }),
              ),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("integrity-mismatch");
    });
  });

  test("integrity mismatch fails with RecipeSourceError integrity-mismatch", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const userDataRoot = join(dir, "data");
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveNpmRecipeSource({
              package: "@lando/recipe-foo",
              userDataRoot,
              registryClient: clientFor(packumentFor(bytes, { integrity: `sha512-${"A".repeat(88)}` })),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("integrity-mismatch");
    });
  });

  test("a missing package (404) fails with package-not-found", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveNpmRecipeSource({
              package: "@lando/recipe-missing",
              userDataRoot: join(dir, "data"),
              registryClient: clientFor(undefined),
              fetcher: fetcherFor(new Uint8Array()),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("package-not-found");
    });
  });

  test("an unresolvable @version fails with version-not-found", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveNpmRecipeSource({
              package: "@lando/recipe-foo@7.7.7",
              userDataRoot: join(dir, "data"),
              registryClient: clientFor(packumentFor(bytes)),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("version-not-found");
    });
  });

  test("a registry fetch error fails with registry-failed", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveNpmRecipeSource({
              package: "@lando/recipe-foo",
              userDataRoot: join(dir, "data"),
              registryClient: {
                fetchPackument: async () => {
                  throw new Error("ECONNREFUSED");
                },
              },
              fetcher: fetcherFor(new Uint8Array()),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("registry-failed");
    });
  });

  test("a tarball download error fails with download-failed", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveNpmRecipeSource({
              package: "@lando/recipe-foo",
              userDataRoot: join(dir, "data"),
              registryClient: clientFor(packumentFor(bytes)),
              fetcher: {
                fetch: async () => {
                  throw new Error("HTTP 500");
                },
              },
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("download-failed");
    });
  });

  test("resolves recipe.yml inside a package subpath", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "nested/recipe.yml": VALID_RECIPE });
      const userDataRoot = join(dir, "data");
      const result = await resolveNpmRecipeSource({
        package: "@lando/recipe-foo",
        path: "nested",
        userDataRoot,
        registryClient: clientFor(packumentFor(bytes)),
        fetcher: fetcherFor(bytes),
      });
      expect(result.root).toBe(
        join(userDataRoot, "recipe-cache", "tarball", sha256(bytes), "package", "nested"),
      );
      expect(await Bun.file(result.source).exists()).toBe(true);
    });
  });
});

describe("initApp npm source boundary", () => {
  test("npm recipes reach manifest parsing before the existing non-bundled render limitation", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeNpmTarball({ "recipe.yml": VALID_RECIPE });
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: false,
          source: "npm",
          package: "@lando/recipe-foo",
          userDataRoot: join(dir, "data"),
          npmRegistryClient: clientFor(packumentFor(bytes)),
          tarballRecipeFetcher: fetcherFor(bytes),
          nonInteractive: true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Recipe file rendering");
      expect((caught as Error).message).toContain("@lando/recipe-foo");
    });
  });
});
