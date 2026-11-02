import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { makeLandoPaths } from "@lando/paths";
import { Effect, Layer } from "effect";

import { sha256Hex } from "@lando/sdk/digest";
import { AbsolutePath } from "@lando/sdk/schema";
import { ContainerHelperAssets, PathsService } from "@lando/sdk/services";

import {
  type EmbeddedHelperFile,
  extractEmbeddedContainerHelper,
  layerWith,
  resolveContainerHelper,
} from "../../src/container-helper/assets.ts";

const target = { os: "linux", arch: "x64" } as const;
const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tempRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-helper-assets-"));
  tempDirs.push(dir);
  return dir;
};

const embedded = (name: string, bytes: Uint8Array): EmbeddedHelperFile =>
  Object.assign(new Blob([gzipSync(bytes)]), { name });

describe("resolveContainerHelper", () => {
  test("the standalone assets layer extracts under its configured PathsService cache root", async () => {
    // Given
    const userCacheRoot = join(await tempRoot(), "runtime-cache");
    const paths = makeLandoPaths({ userCacheRoot });
    const bytes = new TextEncoder().encode("runtime-root-helper");
    const digest = sha256Hex(bytes);
    const assetsLayer = layerWith({
      env: {},
      standalone: true,
      embeddedFiles: [embedded(`lando-container-helper-linux-x64-${digest}.gz`, bytes)],
    }).pipe(Layer.provide(Layer.succeed(PathsService, paths)));

    // When
    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const assets = yield* ContainerHelperAssets;
        return yield* assets.resolve(target);
      }).pipe(Effect.provide(assetsLayer)),
    );

    // Then
    expect(resolved.path).toBe(
      AbsolutePath.make(
        join(
          userCacheRoot,
          "tool-downloads",
          "container-helper",
          "linux-x64",
          digest,
          "lando-container-helper",
        ),
      ),
    );
    expect(await readFile(resolved.path)).toEqual(Buffer.from(bytes));
  });

  test("uses LANDO_CONTAINER_HELPER_DIR/linux-<arch>/lando-container-helper", async () => {
    const root = await tempRoot();
    const path = join(root, "linux-x64", "lando-container-helper");
    await mkdir(join(root, "linux-x64"), { recursive: true });
    await writeFile(path, "helper-bytes");
    const resolved = await Effect.runPromise(
      resolveContainerHelper(target, { env: { LANDO_CONTAINER_HELPER_DIR: root } }),
    );
    expect(resolved).toEqual({
      target,
      digest: sha256Hex(new TextEncoder().encode("helper-bytes")),
      path: AbsolutePath.make(path),
    });
  });

  test("fails with remediation when the override has no binary for the arch", async () => {
    const root = await tempRoot();
    const error = await Effect.runPromise(
      Effect.flip(
        resolveContainerHelper(target, { env: { LANDO_CONTAINER_HELPER_DIR: root }, standalone: false }),
      ),
    );
    expect(error._tag).toBe("ContainerHelperUnavailableError");
    expect(error.message).toContain("linux-x64/lando-container-helper");
    expect(error.remediation).toContain("build:container-helper");
  });

  test("compiled mode extracts the embedded helper for the target arch", async () => {
    const bytes = new TextEncoder().encode("static-helper");
    const digest = sha256Hex(bytes);
    const cacheRoot = await tempRoot();
    const resolved = await Effect.runPromise(
      resolveContainerHelper(target, {
        env: {},
        standalone: true,
        cacheRoot,
        embeddedFiles: [
          embedded(`lando-container-helper-linux-x64-${digest}-a1b2.gz`, bytes),
          embedded(
            `lando-container-helper-linux-arm64-${sha256Hex(new Uint8Array([1]))}.gz`,
            new Uint8Array([1]),
          ),
        ],
      }),
    );
    expect(resolved.digest).toBe(digest);
    expect(resolved.path).toBe(
      AbsolutePath.make(join(cacheRoot, "linux-x64", digest, "lando-container-helper")),
    );
    expect(new TextDecoder().decode(await readFile(resolved.path))).toBe("static-helper");
    expect((await stat(resolved.path)).mode & 0o777).toBe(0o755);
  });
});

describe("extractEmbeddedContainerHelper", () => {
  test("rejects a payload whose bytes do not match the digest in its name", async () => {
    const files = [embedded(`lando-container-helper-linux-x64-${"0".repeat(64)}.gz`, new Uint8Array([7]))];
    await expect(
      extractEmbeddedContainerHelper({ target, files, cacheRoot: await tempRoot() }),
    ).rejects.toThrow("checksum");
  });

  test("requires exactly one helper per architecture", async () => {
    await expect(
      extractEmbeddedContainerHelper({ target, files: [], cacheRoot: await tempRoot() }),
    ).rejects.toThrow("exactly one");
  });

  test("reuses a cached copy whose digest matches", async () => {
    const bytes = new TextEncoder().encode("cached");
    const digest = sha256Hex(bytes);
    const cacheRoot = await tempRoot();
    const files = [embedded(`lando-container-helper-linux-x64-${digest}.gz`, bytes)];
    const first = await extractEmbeddedContainerHelper({ target, files, cacheRoot });
    const before = (await stat(first.path)).mtimeMs;
    const second = await extractEmbeddedContainerHelper({ target, files, cacheRoot });
    expect(second).toEqual(first);
    expect((await stat(second.path)).mtimeMs).toBe(before);
  });
});
