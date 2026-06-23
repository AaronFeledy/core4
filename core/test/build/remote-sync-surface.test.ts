import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

const readRepoFile = (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

const listSpecFiles = async (dir = resolve(repoRoot, "spec")): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return listSpecFiles(path);
      if (!entry.isFile()) return [];
      return /\.(md|json)$/.test(entry.name) ? [path] : [];
    }),
  );

  return files.flat();
};

const expectContains = (content: string, fragment: string): void => {
  expect(content, `missing fragment: ${fragment}`).toContain(fragment);
};

describe("RemoteSource/Dataset canonical surface", () => {
  test("keeps legacy hosting provider identifiers out of spec and PRD identifiers", async () => {
    const files = await listSpecFiles();
    const offenders: Array<string> = [];
    const legacyTokens = ["HostingProvider", "hosting-provider"];

    for (const file of files) {
      const content = await Bun.file(file).text();
      for (const token of legacyTokens) {
        if (content.includes(token)) {
          offenders.push(`${file.slice(repoRoot.length + 1)} (${token})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("keeps RemoteSource and Dataset aligned across canonical surfaces", async () => {
    const [pluggability, pluginManifest, contractSuites, events, landofile, embedding, roadmap, agents] =
      await Promise.all([
        readRepoFile("spec/04-pluggability.md"),
        readRepoFile("spec/10-plugins.md"),
        readRepoFile("spec/13-testing-and-distribution.md"),
        readRepoFile("spec/03-architecture.md"),
        readRepoFile("spec/07-landofile-and-config.md"),
        readRepoFile("spec/09-embedding.md"),
        readRepoFile("spec/ROADMAP.md"),
        readRepoFile("AGENTS.md"),
      ]);
    const services = await import("@lando/sdk/services");

    expectContains(pluggability, "| **Remote data sync** | `RemoteSource` |");
    expectContains(pluggability, "| **Dataset** | `Dataset` |");
    expectContains(pluggability, "Plugin contributes `remoteSources:`");
    expectContains(pluggability, "Plugin contributes `datasets:`");

    expectContains(pluginManifest, "| `remoteSources` | `RemoteSource` implementations");
    expectContains(pluginManifest, "| `datasets` | `Dataset` implementations");

    expectContains(contractSuites, "| RemoteSource contract | Shared contract suite");
    expectContains(contractSuites, "| Dataset contract | Shared contract suite");

    for (const eventName of [
      "pre-pull",
      "post-pull",
      "pre-push",
      "post-push",
      "pre-dataset-fetch",
      "post-dataset-fetch",
      "pre-dataset-apply",
      "post-dataset-apply",
      "pre-dataset-capture",
      "post-dataset-capture",
      "pre-dataset-send",
      "post-dataset-send",
    ]) {
      expectContains(events, eventName);
    }

    expectContains(landofile, "remotes:");
    expectContains(landofile, "sync:");
    expectContains(landofile, "RemoteSource");
    expectContains(landofile, "Dataset");

    expectContains(embedding, "readonly pull:");
    expectContains(embedding, "readonly push:");
    expectContains(embedding, "readonly remote: AppRemoteApi");

    expectContains(roadmap, "`RemoteSource` + `Dataset`");
    expectContains(roadmap, "contract-only");
    expectContains(roadmap, "feature is 4.1");

    expectContains(agents, "RemoteSource/Dataset contract freeze");
    expectContains(agents, "`Dataset` x `RemoteSource`");
    expectContains(agents, "never syncs application code");
    expectContains(agents, "4.1 feature wave");

    expect(services.RemoteSource).toBeDefined();
    expect(services.Dataset).toBeDefined();
  });
});
