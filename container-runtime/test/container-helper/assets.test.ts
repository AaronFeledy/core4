import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { makeLandoPaths } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { AbsolutePath } from "@lando/sdk/schema";
import { ContainerHelperAssets, PathsService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import {
  type EmbeddedHelperFile,
  extractEmbeddedContainerHelper,
  layerWith,
  resolveContainerHelper,
} from "../../src/container-helper/assets.ts";
import {
  CONTAINER_HELPER_COMMANDS,
  CONTAINER_HELPER_PROFILE_HOOK,
  CONTAINER_HELPER_PROFILE_STUB,
  containerHelperCommandShim,
} from "../../src/container-helper.ts";

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

  test("resolves replacement bytes at the same helper path after a successful resolution", async () => {
    const root = await tempRoot();
    const path = join(root, "linux-x64", "lando-container-helper");
    await mkdir(join(root, "linux-x64"));
    await writeFile(path, "first-helper");
    const resolve = () =>
      Effect.runPromise(resolveContainerHelper(target, { env: { LANDO_CONTAINER_HELPER_DIR: root } }));
    const first = await resolve();
    expect((await resolve()).digest).toBe(first.digest);
    await writeFile(path, "other-helper");
    expect((await resolve()).digest).toBe(sha256Hex(new TextEncoder().encode("other-helper")));
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

  test("publishes an immutable shim and the current engine link beside the digest directories", async () => {
    const cacheRoot = await tempRoot();
    const firstBytes = new TextEncoder().encode("first-helper");
    const secondBytes = new TextEncoder().encode("second-helper");
    const resolve = (bytes: Uint8Array) =>
      Effect.runPromise(
        resolveContainerHelper(target, {
          env: {},
          standalone: true,
          cacheRoot,
          embeddedFiles: [embedded(`lando-container-helper-linux-x64-${sha256Hex(bytes)}.gz`, bytes)],
        }),
      );
    await resolve(firstBytes);
    const arch = join(cacheRoot, "linux-x64");
    for (const name of CONTAINER_HELPER_COMMANDS) {
      const shim = join(arch, "shims", name);
      expect(await readFile(shim, "utf8")).toBe(containerHelperCommandShim(name));
      expect((await stat(shim)).mode & 0o777).toBe(0o755);
      expect(sha256Hex(await readFile(join(arch, "engines", name)))).toBe(sha256Hex(firstBytes));
    }
    const shimBefore = (await stat(join(arch, "shims", CONTAINER_HELPER_COMMANDS[0]))).mtimeMs;
    await resolve(secondBytes);
    const probeEngine = join(arch, "engines", "lando-container-helper");
    expect(await readFile(probeEngine)).toEqual(Buffer.from(secondBytes));
    expect((await stat(probeEngine)).mode & 0o777).toBe(0o755);
    for (const name of CONTAINER_HELPER_COMMANDS) {
      expect(sha256Hex(await readFile(join(arch, "engines", name)))).toBe(sha256Hex(secondBytes));
    }
    // The shim is immutable content at a stable path, so a new digest never rewrites it.
    expect((await stat(join(arch, "shims", CONTAINER_HELPER_COMMANDS[0]))).mtimeMs).toBe(shimBefore);
    expect((await readdir(join(arch, "shims"))).filter((name) => name.includes(".lando-stage"))).toEqual([]);
    expect((await readdir(join(arch, "engines"))).filter((name) => name.includes(".lando-stage"))).toEqual(
      [],
    );
  });

  test("publishes the profile stub and replaces a stale hook body at its stable path", async () => {
    // Given a helper directory holding a hook body from an older Lando
    const root = await tempRoot();
    const profile = join(root, "linux-x64", "profile");
    await mkdir(profile, { recursive: true });
    await writeFile(join(root, "linux-x64", "lando-container-helper"), "helper-bytes");
    await writeFile(join(profile, "service-path.sh"), "# older hook body\n");
    // When
    await Effect.runPromise(resolveContainerHelper(target, { env: { LANDO_CONTAINER_HELPER_DIR: root } }));
    // Then the body is current and the stub sources it through the helper mount
    expect(await readFile(join(profile, "service-path.sh"), "utf8")).toBe(CONTAINER_HELPER_PROFILE_HOOK);
    expect(await readFile(join(profile, "zz-lando-service-path.sh"), "utf8")).toBe(
      CONTAINER_HELPER_PROFILE_STUB,
    );
    for (const name of ["service-path.sh", "zz-lando-service-path.sh"])
      expect((await stat(join(profile, name))).mode & 0o777).toBe(0o644);
    expect((await readdir(profile)).filter((name) => name.includes(".lando-stage"))).toEqual([]);
  });

  test("concurrent installs of different digests leave one complete engine and one shim", async () => {
    const cacheRoot = await tempRoot();
    const first = new TextEncoder().encode("concurrent-helper-a");
    const second = new TextEncoder().encode("concurrent-helper-b");
    const resolve = (bytes: Uint8Array) =>
      Effect.runPromise(
        resolveContainerHelper(target, {
          env: {},
          standalone: true,
          cacheRoot,
          embeddedFiles: [embedded(`lando-container-helper-linux-x64-${sha256Hex(bytes)}.gz`, bytes)],
        }),
      );
    await Promise.all(Array.from({ length: 12 }, (_, index) => resolve(index % 2 === 0 ? first : second)));
    const arch = join(cacheRoot, "linux-x64");
    for (const name of CONTAINER_HELPER_COMMANDS) {
      expect([sha256Hex(first), sha256Hex(second)]).toContain(
        sha256Hex(await readFile(join(arch, "engines", name))),
      );
      expect(new TextDecoder().decode(await readFile(join(arch, "shims", name)))).toBe(
        containerHelperCommandShim(name),
      );
    }
    expect((await readdir(join(arch, "engines"))).filter((name) => name.includes(".lando-stage"))).toEqual(
      [],
    );
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
    await chmod(join(cacheRoot, "linux-x64"), 0o700);
    const second = await extractEmbeddedContainerHelper({ target, files, cacheRoot });
    expect(second).toEqual(first);
    expect((await stat(second.path)).mtimeMs).toBe(before);
    expect((await stat(join(cacheRoot, "linux-x64"))).mode & 0o777).toBe(0o755);
  });
});
