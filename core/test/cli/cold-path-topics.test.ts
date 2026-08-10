import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderColdRootHelp } from "../../src/cli/cold-path-output.ts";
import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";

const coreRoot = resolve(import.meta.dirname, "../..");
const expectedTopics = {
  app: { description: "Operate on the current Lando app." },
  "app:cache": { description: "App plan, tooling graph, and command index cache." },
  "app:config": { description: "Read/write the current app's Landofile." },
  "app:includes": { description: "Manage the app's includes lockfile." },
  apps: { description: "Discover and operate across Lando apps on the host." },
  "apps:scratch": { description: "Short-lived scratch apps." },
  meta: { description: "Operate on Lando itself: config, plugins, host setup." },
  "meta:events": { description: "Lifecycle event diagnostics." },
  "meta:global": { description: "Manage the host-level global Lando app." },
  "meta:plugin": { description: "Plugin install, remove, and authoring commands." },
  "meta:recipes": { description: "Inspect canonical recipes shipped with Lando." },
} as const;

describe("cold-path command topics", () => {
  test("manifest embeds native command topic metadata", () => {
    expect(COMMAND_REGISTRY_MANIFEST.topics).toEqual(expectedTopics);
  });

  test("root help renders visible root topics byte-identically from the manifest", () => {
    // Given
    const topicEntries = Object.entries(COMMAND_REGISTRY_MANIFEST.topics).filter(
      ([topic, metadata]) => !topic.includes(":") && (!("hidden" in metadata) || metadata.hidden !== true),
    );
    const expectedBlock = `TOPICS\n${topicEntries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([topic, metadata]) => `  ${topic.padEnd(6)}${metadata.description}`)
      .join("\n")}`;

    // When
    const help = renderColdRootHelp();

    // Then
    expect(topicEntries.map(([topic]) => topic)).toEqual(["app", "apps", "meta"]);
    expect(help).toContain(expectedBlock);
  });

  test("native topic source exists and legacy ownership is absent", async () => {
    // Given
    const packageJson: unknown = await Bun.file(resolve(coreRoot, "package.json")).json();

    // When
    const nativeExists = await Bun.file(resolve(coreRoot, "src/cli/command-topics.ts")).exists();
    const oclif =
      typeof packageJson === "object" && packageJson !== null && "oclif" in packageJson
        ? packageJson.oclif
        : undefined;

    // Then
    expect(nativeExists).toBe(true);
    expect(typeof oclif === "object" && oclif !== null && "topics" in oclif).toBe(false);
  });

  test("cold-path source does not hardcode topic descriptions", async () => {
    // Given / When
    const source = await readFile(resolve(coreRoot, "src/cli/cold-path-output.ts"), "utf8");

    // Then
    for (const { description } of Object.values(expectedTopics)) {
      expect(source).not.toContain(description);
    }
  });
});
