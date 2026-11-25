import { expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureHostProxyContainerDirectory,
  hostProxyContainerGeneration,
  resetHostProxyRunDirectory,
} from "../../../src/subsystems/host-proxy/run-directory.ts";

test.skipIf(process.platform === "win32")(
  "replacing a worker keeps the container-facing directory running containers bind, and its generation",
  async () => {
    // Given a run directory holding worker state and a dead session's container-facing files.
    const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-run-"));
    const runDir = join(root, "run");
    try {
      const containerDir = await ensureHostProxyContainerDirectory(runDir);
      const before = await lstat(containerDir);
      const generation = await hostProxyContainerGeneration(runDir);
      await writeFile(join(runDir, "worker.json"), "{}");
      await writeFile(join(runDir, "lando"), "shim");
      await writeFile(join(containerDir, "sock"), "dead socket");
      await writeFile(join(containerDir, "credentials"), "{}");
      // When the successor clears the run directory.
      await resetHostProxyRunDirectory(runDir);
      // Then only the same container-facing directory survives, holding only its unchanged generation.
      expect(await readdir(runDir)).toEqual(["container"]);
      expect((await lstat(containerDir)).ino).toBe(before.ino);
      expect(await readdir(containerDir)).toEqual([".generation"]);
      expect(await ensureHostProxyContainerDirectory(runDir)).toBe(containerDir);
      expect((await lstat(containerDir)).ino).toBe(before.ino);
      expect(await hostProxyContainerGeneration(runDir)).toBe(generation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a container-facing directory gets one read-only generation when it is created",
  async () => {
    // Given a fresh run directory.
    const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-run-"));
    const runDir = join(root, "run");
    try {
      // When sessions ensure its container-facing directory, concurrently and again later.
      const [first, second] = await Promise.all([
        hostProxyContainerGeneration(runDir),
        hostProxyContainerGeneration(runDir),
      ]);
      await ensureHostProxyContainerDirectory(runDir);
      // Then every caller sees one generation, published once as a read-only file with no staging left.
      expect(second).toBe(first);
      expect(first).toMatch(/^[0-9a-f]{32}$/u);
      expect(await hostProxyContainerGeneration(runDir)).toBe(first);
      expect(await readdir(join(runDir, "container"))).toEqual([".generation"]);
      expect((await lstat(join(runDir, "container", ".generation"))).mode & 0o777).toBe(0o444);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const damage of ["permissive directory", "tampered generation"] as const) {
  test.skipIf(process.platform === "win32")(
    `a run directory with a ${damage} is removed whole and recreated under a new generation`,
    async () => {
      // Given a container-facing directory another user could change, or whose generation was rewritten.
      const root = await mkdtemp(join(tmpdir(), "lando-host-proxy-run-"));
      const runDir = join(root, "run");
      try {
        const containerDir = await ensureHostProxyContainerDirectory(runDir);
        const generation = await hostProxyContainerGeneration(runDir);
        switch (damage) {
          case "permissive directory":
            await chmod(containerDir, 0o777);
            break;
          case "tampered generation":
            await chmod(join(containerDir, ".generation"), 0o644);
            await writeFile(join(containerDir, ".generation"), "not a generation");
            break;
          default:
            return damage satisfies never;
        }
        // When the successor clears the run directory.
        await resetHostProxyRunDirectory(runDir);
        // Then nothing is kept, and the next session's directory is a new generation.
        expect(await readdir(root)).toEqual([]);
        expect(await hostProxyContainerGeneration(runDir)).not.toBe(generation);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
