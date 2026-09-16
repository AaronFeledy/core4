import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Cause, Effect, Exit, Runtime } from "effect";

import { DownloadFetchError, RecipeManifestNotFoundError, RecipeSourceError } from "@lando/sdk/errors";
import { RecipeManifestService } from "@lando/sdk/services";

import type { InteractionPrompter } from "../../src/interaction/prompter.ts";
import { RecipeManifestServiceLive } from "../../src/recipes/manifest/service.ts";
import {
  type TarballRecipeFetcher,
  defaultTarballRecipeExtractor,
  defaultTarballRecipeFetcher,
  makeTarballRecipeExtractor,
  resolveTarballRecipeSource,
} from "../../src/recipes/tarball-source.ts";
import { initAppWithOwnerOnlyFileAccess as initApp } from "../_support/private-file-access.ts";

const VALID_RECIPE = `id: remote-recipe
title: Remote Recipe
description: A tarball sourced recipe.
version: 0.1.0
prompts:
  - name: name
    type: text
    message: App name
    default: tarball-app
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
`;

const withTempRoot = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-tarball-recipe-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Build a real `.tar.gz` from an in-memory file map using the host `tar`. Keys
 * are archive-relative paths; an explicit empty `recipe.yml` set is allowed for
 * the "missing manifest" cases.
 */
const makeTarball = async (files: Readonly<Record<string, string>>): Promise<Uint8Array> => {
  const stage = await realpath(await mkdtemp(join(tmpdir(), "lando-tarball-build-")));
  const content = join(stage, "content");
  const out = join(stage, "archive.tar.gz");
  try {
    await mkdir(content, { recursive: true });
    for (const [rel, fileContent] of Object.entries(files)) {
      const target = join(content, rel);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, fileContent);
    }
    const proc = Bun.spawn({
      cmd: ["tar", "-czf", out, "-C", content, "."],
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

interface TarEntrySpec {
  readonly name: string;
  readonly bytes?: Uint8Array;
  readonly typeflag?: string;
  readonly linkname?: string;
}

const makeTarballEntries = (entries: ReadonlyArray<TarEntrySpec>): Uint8Array => {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? new Uint8Array();
    const header = Buffer.alloc(512);
    Buffer.from(entry.name).copy(header, 0, 0, 100);
    Buffer.from("0000644\0").copy(header, 100);
    Buffer.from(bytes.byteLength.toString(8).padStart(11, "0")).copy(header, 124);
    header[135] = 0;
    header.fill(0x20, 148, 156);
    header[156] = (entry.typeflag ?? "0").charCodeAt(0);
    if (entry.linkname !== undefined) Buffer.from(entry.linkname).copy(header, 157, 0, 100);
    Buffer.from("ustar\0").copy(header, 257);
    Buffer.from("00").copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `).copy(header, 148);
    blocks.push(header, Buffer.from(bytes));
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
};

const fetcherFor = (bytes: Uint8Array, calls?: Array<string>): TarballRecipeFetcher => ({
  fetch: async (url) => {
    calls?.push(url);
    return bytes;
  },
});

const sha256 = (bytes: Uint8Array): string =>
  require("node:crypto").createHash("sha256").update(bytes).digest("hex");

const withEnv = async (name: string, value: string, run: () => Promise<void>): Promise<void> => {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
};

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

describe("resolveTarballRecipeSource", () => {
  test.each([
    { hostileEntries: [{ name: "../escape", bytes: Buffer.from("outside") }] },
    {
      hostileEntries: [
        { name: "././@LongLink", bytes: Buffer.from("../gnu-longname-escape\0"), typeflag: "L" },
        { name: "placeholder", bytes: Buffer.from("outside") },
      ],
    },
  ])("rejects traversal without publishing and cleans its staging tree", async ({ hostileEntries }) => {
    // Given: a sentinel root and an archive that writes a valid member before a traversal member.
    await withTempRoot(async (dir) => {
      const sentinel = join(dir, "sentinel");
      const marker = join(sentinel, "marker");
      const userDataRoot = join(dir, "data");
      await mkdir(sentinel, { recursive: true });
      await writeFile(marker, "unchanged");
      const bytes = makeTarballEntries([
        { name: "recipe.yml", bytes: Buffer.from(VALID_RECIPE) },
        ...hostileEntries,
      ]);

      // When: the archive is resolved through the real tarball publication boundary.
      let caught: unknown;
      try {
        await resolveTarballRecipeSource({
          url: "https://example.test/hostile.tar.gz",
          userDataRoot,
          fetcher: fetcherFor(bytes),
        });
      } catch (error) {
        caught = error;
      }

      // Then: extraction fails, the sentinel is unchanged, and no cache or staging tree is published.
      expect(caught).toBeInstanceOf(RecipeSourceError);
      expect(await readFile(marker, "utf8")).toBe("unchanged");
      const cacheRoot = join(userDataRoot, "recipe-cache", "tarball");
      expect(await Bun.file(join(cacheRoot, "escape")).exists()).toBe(false);
      expect(await Bun.file(join(cacheRoot, "gnu-longname-escape")).exists()).toBe(false);
      expect((await readdir(dir, { recursive: true })).sort()).toEqual(
        [
          "data",
          join("data", "recipe-cache"),
          join("data", "recipe-cache", "tarball"),
          "sentinel",
          join("sentinel", "marker"),
        ].sort(),
      );
    });
  });

  test("skips links, devices, FIFOs, and PAX metadata while publishing regular siblings", async () => {
    // Given: nonregular members surrounding regular members, including a symlink-then-file alias.
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const bytes = makeTarballEntries([
        { name: "recipe.yml", bytes: Buffer.from(VALID_RECIPE) },
        { name: "templates/payload", typeflag: "2", linkname: "../../sentinel" },
        { name: "templates/payload", bytes: Buffer.from("regular") },
        { name: "templates/hard", typeflag: "1", linkname: "recipe.yml" },
        { name: "templates/fifo", typeflag: "6" },
        { name: "templates/device", typeflag: "3" },
        { name: "pax", bytes: Buffer.from("path=ignored\n"), typeflag: "x" },
        { name: "templates/sibling", bytes: Buffer.from("published") },
      ]);

      // When: the archive is resolved and published.
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/nonregular.tar.gz",
        userDataRoot,
        fetcher: fetcherFor(bytes),
      });

      // Then: regular files publish byte-for-byte and skipped member types create nothing.
      expect(await readFile(join(result.root ?? "", "templates", "payload"), "utf8")).toBe("regular");
      expect(await readFile(join(result.root ?? "", "templates", "sibling"), "utf8")).toBe("published");
      expect(await Bun.file(join(result.root ?? "", "templates", "hard")).exists()).toBe(false);
      expect(await Bun.file(join(result.root ?? "", "templates", "fifo")).exists()).toBe(false);
      expect(await Bun.file(join(result.root ?? "", "templates", "device")).exists()).toBe(false);
      const published = join("data", "recipe-cache", "tarball", sha256(bytes));
      expect((await readdir(dir, { recursive: true })).sort()).toEqual(
        [
          "data",
          join("data", "recipe-cache"),
          join("data", "recipe-cache", "tarball"),
          published,
          join(published, "recipe.yml"),
          join(published, "templates"),
          join(published, "templates", "payload"),
          join(published, "templates", "sibling"),
        ].sort(),
      );
    });
  });

  // The drive-name fixture creates a literal C: directory, which Windows filesystems cannot represent.
  test.skipIf(process.platform === "win32")(
    "normalizes rooted member names inside the publication tree",
    async () => {
      // Given: absolute, drive-rooted, and UNC-like member names accepted by the normalization contract.
      await withTempRoot(async (dir) => {
        const bytes = makeTarballEntries([
          { name: "recipe.yml", bytes: Buffer.from(VALID_RECIPE) },
          { name: "/absolute.txt", bytes: Buffer.from("absolute") },
          { name: "C:\\drive.txt", bytes: Buffer.from("drive") },
          { name: "\\\\server\\share.txt", bytes: Buffer.from("unc") },
        ]);

        // When: the archive is published.
        const result = await resolveTarballRecipeSource({
          url: "https://example.test/rooted.tar.gz",
          userDataRoot: join(dir, "data"),
          fetcher: fetcherFor(bytes),
        });

        // Then: each name resolves beneath the cache root rather than to a host-rooted path.
        const root = result.root ?? "";
        expect(await readFile(join(root, "absolute.txt"), "utf8")).toBe("absolute");
        expect(await readFile(join(root, "C:", "drive.txt"), "utf8")).toBe("drive");
        expect(await readFile(join(root, "server", "share.txt"), "utf8")).toBe("unc");
        const published = join("data", "recipe-cache", "tarball", sha256(bytes));
        expect((await readdir(dir, { recursive: true })).sort()).toEqual(
          [
            "data",
            join("data", "recipe-cache"),
            join("data", "recipe-cache", "tarball"),
            published,
            join(published, "recipe.yml"),
            join(published, "absolute.txt"),
            join(published, "C:"),
            join(published, "C:", "drive.txt"),
            join(published, "server"),
            join(published, "server", "share.txt"),
          ].sort(),
        );
      });
    },
  );

  test("normalizes duplicate path aliases to one last-member-wins file", async () => {
    // Given: two regular members whose slash and dot aliases normalize to the same path.
    await withTempRoot(async (dir) => {
      const bytes = makeTarballEntries([
        { name: "recipe.yml", bytes: Buffer.from(VALID_RECIPE) },
        { name: "templates/./payload", bytes: Buffer.from("first") },
        { name: "templates//payload", bytes: Buffer.from("second") },
      ]);

      // When: the archive is published.
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/aliases.tar.gz",
        userDataRoot: join(dir, "data"),
        fetcher: fetcherFor(bytes),
      });

      // Then: the normalized destination contains the final regular member bytes.
      expect(await readFile(join(result.root ?? "", "templates", "payload"), "utf8")).toBe("second");
      const published = join("data", "recipe-cache", "tarball", sha256(bytes));
      expect((await readdir(dir, { recursive: true })).sort()).toEqual(
        [
          "data",
          join("data", "recipe-cache"),
          join("data", "recipe-cache", "tarball"),
          published,
          join(published, "recipe.yml"),
          join(published, "templates"),
          join(published, "templates", "payload"),
        ].sort(),
      );
    });
  });

  test("gzip archives exceeding the decompressed-size cap fail as extract-failed", async () => {
    await withTempRoot(async (dir) => {
      const cap = 4096;
      const bytes = await makeTarball({ "payload.bin": "\0".repeat(64 * 1024) });
      const extractor = makeTarballRecipeExtractor({ maxDecompressedBytes: cap });

      let caught: unknown;
      try {
        await extractor.extract(bytes, join(dir, "out"));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(RecipeSourceError);
      if (caught instanceof RecipeSourceError) {
        expect(caught.kind).toBe("extract-failed");
        expect(caught.message).toContain("decompressed-size cap");
        expect(caught.message).toContain(`${cap}`);
        expect(caught.remediation).toContain("unreasonably large");
        expect(caught.remediation).toContain("re-publish a smaller archive");
      }
    });
  });

  test("gzip archives under the decompressed-size cap extract byte-for-byte", async () => {
    await withTempRoot(async (dir) => {
      const content = "under-cap payload\n".repeat(32);
      const bytes = await makeTarball({ "nested/payload.txt": content });
      const extractor = makeTarballRecipeExtractor({ maxDecompressedBytes: 1024 * 1024 });

      await extractor.extract(bytes, join(dir, "out"));

      const extracted = await readFile(join(dir, "out", "nested", "payload.txt"));
      expect(extracted).toEqual(Buffer.from(content, "utf8"));
    });
  });

  test("default tarball extractor still extracts a normal recipe archive", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });

      await defaultTarballRecipeExtractor.extract(bytes, join(dir, "out"));

      expect(await Bun.file(join(dir, "out", "recipe.yml")).text()).toBe(VALID_RECIPE);
    });
  });

  test("downloads, extracts, and publishes under userDataRoot/recipe-cache/tarball/<sha256>", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const calls: Array<string> = [];
      const userDataRoot = join(dir, "data");
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot,
        fetcher: fetcherFor(bytes, calls),
      });

      expect(calls).toEqual(["https://example.test/recipe.tar.gz"]);
      expect(result.sha256).toBe(sha256(bytes));
      const root = result.root;
      if (root === undefined) throw new Error("expected tarball recipe root");
      expect(root).toBe(join(userDataRoot, "recipe-cache", "tarball", result.sha256));
      const source = result.source;
      if (source === undefined) throw new Error("expected tarball recipe source path");
      const manifestYaml =
        result.manifestYaml ??
        (() => {
          throw new Error("expected tarball recipe manifest YAML");
        })();
      expect(source).toBe(join(root, "recipe.yml"));
      expect(await Bun.file(source).exists()).toBe(true);
      const manifest = await Effect.runPromise(
        Effect.flatMap(RecipeManifestService, (svc) => svc.parse(source, manifestYaml)).pipe(
          Effect.provide(RecipeManifestServiceLive),
        ),
      );
      expect(manifest.id).toBe("remote-recipe");
    });
  });

  test("cache hit keeps the published dir and re-downloads bytes only to derive the sha", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const userDataRoot = join(dir, "data");
      const published = join(userDataRoot, "recipe-cache", "tarball", sha256(bytes));
      await mkdir(published, { recursive: true });
      await writeFile(join(published, "recipe.yml"), VALID_RECIPE.replace("Remote Recipe", "Cached Recipe"));
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot,
        fetcher: fetcherFor(bytes),
      });
      expect(result.root).toBe(published);
      expect(await Bun.file(result.source).text()).toContain("Cached Recipe");
      const staging = await Array.fromAsync(
        new Bun.Glob(".staging-*").scan({
          cwd: join(userDataRoot, "recipe-cache", "tarball"),
          onlyFiles: false,
        }),
      );
      expect(staging).toEqual([]);
    });
  });

  test("passing a matching --checksum verifies successfully", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot: join(dir, "data"),
        checksum: sha256(bytes),
        fetcher: fetcherFor(bytes),
      });
      expect(result.sha256).toBe(sha256(bytes));
    });
  });

  test("checksum mismatch fails with RecipeSourceError checksum-mismatch and does not extract", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const userDataRoot = join(dir, "data");
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot,
              checksum: "0".repeat(64),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("checksum-mismatch");
      const published = await Array.fromAsync(
        new Bun.Glob("*").scan({ cwd: join(userDataRoot, "recipe-cache", "tarball"), onlyFiles: false }),
      ).catch(() => []);
      expect(published).toEqual([]);
    });
  });

  test("malformed --checksum (not 64 hex) fails with checksum-mismatch", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot: join(dir, "data"),
              checksum: "not-a-real-hash",
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("checksum-mismatch");
    });
  });

  test("no --checksum warns once and proceeds when no confirm seam is supplied", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const warnings: Array<string> = [];
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot: join(dir, "data"),
        fetcher: fetcherFor(bytes),
        onWarn: (message) => warnings.push(message),
      });
      expect(result.sha256).toBe(sha256(bytes));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(sha256(bytes));
    });
  });

  test("no --checksum with a declined confirm aborts with checksum-unverified", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const seen: Array<string> = [];
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot: join(dir, "data"),
              fetcher: fetcherFor(bytes),
              confirmUnverified: async (hash) => {
                seen.push(hash);
                return false;
              },
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("checksum-unverified");
      expect(seen).toEqual([sha256(bytes)]);
    });
  });

  test("no --checksum with an accepted confirm proceeds", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        userDataRoot: join(dir, "data"),
        fetcher: fetcherFor(bytes),
        confirmUnverified: async () => true,
      });
      expect(result.sha256).toBe(sha256(bytes));
    });
  });

  test("resolves recipe.yml inside a safe monorepo subpath", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "packages/remote-recipe/recipe.yml": VALID_RECIPE });
      const userDataRoot = join(dir, "data");
      const result = await resolveTarballRecipeSource({
        url: "https://example.test/recipe.tar.gz",
        path: "packages/remote-recipe",
        userDataRoot,
        fetcher: fetcherFor(bytes),
      });
      expect(result.root).toBe(
        join(userDataRoot, "recipe-cache", "tarball", result.sha256, "packages", "remote-recipe"),
      );
      expect(await Bun.file(result.source).exists()).toBe(true);
    });
  });

  test.each(["/absolute", "../escape", "safe/../../escape"])("rejects unsafe subpath %s", async (path) => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              path,
              userDataRoot: join(dir, "data"),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("subpath-invalid");
    });
  });

  test("missing top-level recipe.yml uses RecipeManifestNotFoundError", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "readme.txt": "no recipe here" });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot: join(dir, "data"),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      expect(expectFailure(exit)).toBeInstanceOf(RecipeManifestNotFoundError);
    });
  });

  test("missing recipe.yml at a subpath returns RecipeSourceError subpath-missing", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "packages/other/recipe.yml": VALID_RECIPE });
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              path: "packages/missing",
              userDataRoot: join(dir, "data"),
              fetcher: fetcherFor(bytes),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("subpath-missing");
    });
  });

  test("download failure becomes RecipeSourceError download-failed", async () => {
    await withTempRoot(async (dir) => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/missing.tar.gz",
              userDataRoot: join(dir, "data"),
              fetcher: {
                fetch: async () => {
                  throw new Error("HTTP 404 Not Found");
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

  test("non-tar bytes become RecipeSourceError extract-failed", async () => {
    await withTempRoot(async (dir) => {
      const userDataRoot = join(dir, "data");
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () =>
            resolveTarballRecipeSource({
              url: "https://example.test/recipe.tar.gz",
              userDataRoot,
              // Gzip magic bytes followed by garbage so gunzip throws.
              fetcher: fetcherFor(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04])),
            }),
          catch: (cause) => cause,
        }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(RecipeSourceError);
      if (failure instanceof RecipeSourceError) expect(failure.kind).toBe("extract-failed");
    });
  });
});

describe("initApp tarball source boundary", () => {
  test("tarball checksum confirmation includes the downloaded SHA-256 guidance", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const prompts: Array<string> = [];
      const interaction: InteractionPrompter = {
        promptAll: async () => ({}),
        confirm: async (spec) => {
          prompts.push(spec.message);
          return true;
        },
        select: async (spec) => {
          const firstChoice = spec.choices[0];
          const fallback =
            typeof firstChoice === "object" && firstChoice !== null && "value" in firstChoice
              ? firstChoice.value
              : firstChoice;
          const value = spec.default ?? fallback;
          if (value === undefined) throw new Error("select test prompt has no value");
          return value;
        },
      };

      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: false,
          source: "tarball",
          url: "https://example.test/recipe.tar.gz",
          userDataRoot: join(dir, "data"),
          tarballRecipeFetcher: fetcherFor(bytes),
          interaction,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("No --checksum supplied");
      expect(prompts[0]).toContain(sha256(bytes));
    });
  });

  test("tarball recipes reach manifest parsing before the existing non-bundled render limitation", async () => {
    await withTempRoot(async (dir) => {
      const bytes = await makeTarball({ "recipe.yml": VALID_RECIPE });
      const warnings: Array<string> = [];
      let caught: unknown;
      try {
        await initApp({
          cwd: dir,
          full: false,
          source: "tarball",
          url: "https://example.test/recipe.tar.gz",
          userDataRoot: join(dir, "data"),
          tarballRecipeFetcher: fetcherFor(bytes),
          nonInteractive: true,
          onWarn: (message) => warnings.push(message),
        });
      } catch (error) {
        caught = error;
      }
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("No --checksum supplied");
      expect(warnings[0]).toContain(sha256(bytes));
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Recipe file rendering");
      expect((caught as Error).message).toContain("https://example.test/recipe.tar.gz");
    });
  });

  describe("defaultTarballRecipeFetcher", () => {
    test("applies ConfigService-backed network trust to archive downloads", async () => {
      await withTempRoot(async (dir) => {
        const missingCa = join(dir, "missing-ca.pem");
        await withEnv("LANDO_NETWORK_CA_CERTS", JSON.stringify([missingCa]), async () => {
          let caught: unknown;
          try {
            await defaultTarballRecipeFetcher.fetch("https://example.test/archive.tgz");
          } catch (error) {
            caught = error;
          }
          expect(Runtime.isFiberFailure(caught)).toBe(true);
          if (!Runtime.isFiberFailure(caught)) throw new Error("expected Effect fiber failure");
          const failure = Cause.failureOption(caught[Runtime.FiberFailureCauseId]);
          expect(failure._tag).toBe("Some");
          if (failure._tag !== "Some") throw new Error("expected typed download failure");
          expect(failure.value).toBeInstanceOf(DownloadFetchError);
          if (!(failure.value instanceof DownloadFetchError))
            throw new Error("expected download fetch failure");
          expect(failure.value._tag).toBe("DownloadFetchError");
          expect(failure.value.message).toContain(`CA certificate could not be read: ${missingCa}`);
          expect(failure.value.remediation).toContain("network.ca.certs");
          expect(failure.value.remediation).toContain("LANDO_NETWORK_CA_CERTS");
          expect(failure.value.remediation).toContain("security.ca");
        });
      });
    });

    test("rejects non-https sources by routing through the Downloader scheme gate", async () => {
      const server = Bun.serve({
        fetch: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        hostname: "127.0.0.1",
        port: 0,
      });
      try {
        let caught: unknown;
        try {
          await defaultTarballRecipeFetcher.fetch(`http://127.0.0.1:${server.port}/archive.tgz`);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
      } finally {
        server.stop(true);
      }
    });
  });
});
