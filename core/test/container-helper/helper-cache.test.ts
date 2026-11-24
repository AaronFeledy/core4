import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONTAINER_HELPER_BINARY_NAMES,
  publishContainerHelper,
  restoreContainerHelper,
} from "../../../scripts/container-helper-cache.ts";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-helper-cache-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** A helper build as `build:container-helper` leaves it, recording `recorded` as its source digest. */
const writeBuild = async (dist: string, recorded: string) => {
  const files: Record<string, string> = {
    ...Object.fromEntries(CONTAINER_HELPER_BINARY_NAMES.map((name) => [name, `binary ${name} ${recorded}`])),
    "licenses/go/LICENSE": "license",
    "licenses/go/files.json": '["licenses/go/LICENSE"]',
    "source-digest": `${recorded}\n`,
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dist, name)), { recursive: true });
    await writeFile(join(dist, name), content);
  }
};

test("Given a published build, when another checkout restores it, then it gets the same bytes and the current digest", () =>
  withRoot(async (root) => {
    const cacheRoot = join(root, "cache");
    await writeBuild(join(root, "built"), digest);
    expect(await publishContainerHelper({ dist: join(root, "built"), sourceDigest: digest, cacheRoot })).toBe(
      "published",
    );

    const dist = join(root, "fresh", "dist");
    const restored = await restoreContainerHelper({ dist, sourceDigest: digest, cacheRoot });

    expect(restored.status).toBe("restored");
    for (const name of [...CONTAINER_HELPER_BINARY_NAMES, "licenses/go/LICENSE", "licenses/go/files.json"])
      expect(await readFile(join(dist, name), "utf8")).toBe(
        await readFile(join(root, "built", name), "utf8"),
      );
    for (const name of CONTAINER_HELPER_BINARY_NAMES)
      expect((await stat(join(dist, name))).mode & 0o777).toBe(0o755);
    expect((await readFile(join(dist, "source-digest"), "utf8")).trim()).toBe(digest);
    expect(await restoreContainerHelper({ dist, sourceDigest: digest, cacheRoot })).toEqual({
      status: "current",
    });
  }));

test("Given only a cache entry for other sources, when restoring a stale build, then nothing is restored and the stale digest stays", () =>
  withRoot(async (root) => {
    const cacheRoot = join(root, "cache");
    await writeBuild(join(root, "built"), otherDigest);
    await publishContainerHelper({ dist: join(root, "built"), sourceDigest: otherDigest, cacheRoot });
    // An entry stored under the wanted key whose record names other sources is never trusted.
    await rm(join(cacheRoot, digest), { recursive: true, force: true });
    await cp(join(cacheRoot, otherDigest), join(cacheRoot, digest), { recursive: true });
    const dist = join(root, "stale", "dist");
    await writeBuild(dist, otherDigest);

    const restored = await restoreContainerHelper({ dist, sourceDigest: digest, cacheRoot });

    expect(restored).toMatchObject({ status: "missing", reason: expect.stringContaining(otherDigest) });
    expect((await readFile(join(dist, "source-digest"), "utf8")).trim()).toBe(otherDigest);
  }));

test("Given a build that records other sources, when publishing it, then the cache refuses it", () =>
  withRoot(async (root) => {
    await writeBuild(join(root, "built"), otherDigest);

    await expect(
      publishContainerHelper({
        dist: join(root, "built"),
        sourceDigest: digest,
        cacheRoot: join(root, "cache"),
      }),
    ).rejects.toThrow("Refusing to cache");
    expect(await Bun.file(join(root, "cache", digest, "entry.json")).exists()).toBe(false);
  }));

test("Given a damaged cache entry, when restoring, then it is refused, and a later publish replaces it", () =>
  withRoot(async (root) => {
    const cacheRoot = join(root, "cache");
    await writeBuild(join(root, "built"), digest);
    await publishContainerHelper({ dist: join(root, "built"), sourceDigest: digest, cacheRoot });
    const [binary] = CONTAINER_HELPER_BINARY_NAMES;
    await writeFile(join(cacheRoot, digest, binary ?? ""), "truncated");
    const dist = join(root, "fresh", "dist");

    expect(await restoreContainerHelper({ dist, sourceDigest: digest, cacheRoot })).toMatchObject({
      status: "missing",
      reason: expect.stringContaining("missing or damaged"),
    });
    expect(await Bun.file(join(dist, "source-digest")).exists()).toBe(false);

    expect(await publishContainerHelper({ dist: join(root, "built"), sourceDigest: digest, cacheRoot })).toBe(
      "published",
    );
    expect((await restoreContainerHelper({ dist, sourceDigest: digest, cacheRoot })).status).toBe("restored");
  }));

test("Given several checkouts publishing the same digest at once, when they race, then one entry wins and no staging is left", () =>
  withRoot(async (root) => {
    const cacheRoot = join(root, "cache");
    const builds = Array.from({ length: 6 }, (_, index) => join(root, `built-${index}`));
    for (const dist of builds) await writeBuild(dist, digest);

    const results = await Promise.all(
      builds.map((dist) => publishContainerHelper({ dist, sourceDigest: digest, cacheRoot })),
    );

    expect(results.filter((result) => result === "published")).toHaveLength(1);
    expect(await readdir(cacheRoot)).toEqual([digest]);
    const restored = await restoreContainerHelper({
      dist: join(root, "fresh", "dist"),
      sourceDigest: digest,
      cacheRoot,
    });
    expect(restored.status).toBe("restored");
  }));

test("Given no cache entry, when restoring, then the helper is reported missing", () =>
  withRoot(async (root) => {
    expect(
      await restoreContainerHelper({
        dist: join(root, "dist"),
        sourceDigest: digest,
        cacheRoot: join(root, "cache"),
      }),
    ).toMatchObject({ status: "missing", reason: `no cached build for source digest ${digest}` });
  }));
