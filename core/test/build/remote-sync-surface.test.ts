import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

const SOURCE_ROOTS = ["sdk/src", "core/src", "plugins"] as const;

const LEGACY_TOKENS = ["HostingProvider", "hosting-provider"] as const;

/** Every sync lifecycle event the RemoteSource/Dataset contract publishes. */
const SYNC_EVENT_EXPORTS = [
  "PrePullEvent",
  "PostPullEvent",
  "PrePushEvent",
  "PostPushEvent",
  "PreDatasetFetchEvent",
  "PostDatasetFetchEvent",
  "PreDatasetApplyEvent",
  "PostDatasetApplyEvent",
  "PreDatasetCaptureEvent",
  "PostDatasetCaptureEvent",
  "PreDatasetSendEvent",
  "PostDatasetSendEvent",
] as const;

const listSourceFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listSourceFiles(path);
      if (!entry.isFile()) return [];
      return /\.tsx?$/u.test(entry.name) ? [path] : [];
    }),
  );

  return files.flat();
};

describe("RemoteSource/Dataset canonical surface", () => {
  test("publishes the RemoteSource and Dataset service tags from @lando/sdk/services", async () => {
    // Given/When: the published SDK service surface is loaded.
    const services = await import("@lando/sdk/services");

    // Then: both contract tags are part of it.
    expect(services.RemoteSource).toBeDefined();
    expect(services.Dataset).toBeDefined();
  });

  test("publishes every remote-sync lifecycle event schema from @lando/sdk/events", async () => {
    // Given/When: the published event taxonomy is loaded.
    const events: Readonly<Record<string, unknown>> = await import("@lando/sdk/events");

    // Then: each sync event schema is exported.
    const missing = SYNC_EVENT_EXPORTS.filter((name) => events[name] === undefined);
    expect(missing).toEqual([]);
  });

  test("keeps legacy hosting-provider identifiers out of shipped source", async () => {
    // Given: every TypeScript source file in the shipped packages.
    const files = (
      await Promise.all(SOURCE_ROOTS.map((root) => listSourceFiles(resolve(repoRoot, root))))
    ).flat();

    // When: each file is scanned for the superseded contract identifiers.
    const offenders: string[] = [];
    for (const file of files) {
      const content = await Bun.file(file).text();
      for (const token of LEGACY_TOKENS) {
        if (content.includes(token)) offenders.push(`${file.slice(repoRoot.length + 1)} (${token})`);
      }
    }

    // Then: none remain.
    expect(offenders).toEqual([]);
  });
});
