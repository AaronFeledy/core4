import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  isHelpTopic,
  renderColdAllHelp,
  renderColdRootHelp,
  renderColdTopicHelp,
} from "../../src/cli/cold-path-output.ts";
import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";

const coreRoot = resolve(import.meta.dirname, "../..");
const expectedTopics = {
  app: { description: "Operate on the current Lando app." },
  "app:cache": { description: "App plan, tooling graph, and command index cache." },
  "app:config": { description: "Read/write the current app's Landofile." },
  "app:includes": { description: "Manage the app's includes lockfile." },
  apps: { description: "Discover and operate across Lando apps on the host." },
  "apps:scratch": { description: "Short-lived scratch apps." },
  scratch: { description: "Short-lived scratch apps." },
  meta: { description: "Operate on Lando itself: config, plugins, host setup." },
  "meta:events": { description: "Lifecycle event diagnostics." },
  "meta:global": { description: "Manage the host-level global Lando app." },
  global: { description: "Manage the host-level global Lando app." },
  "meta:plugin": { description: "Plugin install, remove, and authoring commands." },
  plugin: { description: "Plugin install, remove, and authoring commands." },
  "meta:recipes": { description: "Inspect canonical recipes shipped with Lando." },
  recipes: { description: "Inspect canonical recipes shipped with Lando." },
} as const;

const MORE_POINTERS = [
  "lando help app",
  "lando help apps",
  "lando help plugin",
  "lando help global",
  "lando help recipes",
  "lando help --all",
  "lando <command> --help",
] as const;

describe("cold-path command topics", () => {
  test("manifest embeds native command topic metadata", () => {
    expect(COMMAND_REGISTRY_MANIFEST.topics).toEqual(expectedTopics);
  });

  test("root help renders MORE pointers instead of a TOPICS dump", () => {
    // Given / When
    const help = renderColdRootHelp(undefined, { style: false });

    // Then
    expect(help).toContain("MORE");
    expect(help).not.toContain("TOPICS");
    for (const pointer of MORE_POINTERS) {
      expect(help).toContain(pointer);
    }
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

describe("cold-path topic and all help", () => {
  test("isHelpTopic accepts locked topics and rejects unknown tokens", () => {
    // Given locked topic names and an unknown token
    // When the guard runs
    // Then only the shipped topics match
    expect(isHelpTopic("app")).toBe(true);
    expect(isHelpTopic("apps")).toBe(true);
    expect(isHelpTopic("plugin")).toBe(true);
    expect(isHelpTopic("global")).toBe(true);
    expect(isHelpTopic("recipes")).toBe(true);
    expect(isHelpTopic("scratch")).toBe(true);
    expect(isHelpTopic("meta")).toBe(false);
    expect(isHelpTopic("nope")).toBe(false);
  });

  test("renderColdTopicHelp lists non-common app commands and omits COMMON start", () => {
    // Given / When
    const help = renderColdTopicHelp("app", { style: false });

    // Then
    expect(help).toContain("config");
    expect(help).not.toMatch(/^\s+start\s/m);
    expect(help).not.toContain("meta:plugin:login");
  });

  test("renderColdTopicHelp puts authoring plugin commands under AUTHORING and omits deferred login", () => {
    // Given / When
    const help = renderColdTopicHelp("plugin", { style: false });

    // Then
    expect(help).toContain("plugin:add");
    expect(help).toContain("AUTHORING");
    expect(help).toContain("plugin:new");
    expect(help).not.toContain("plugin:login");
  });

  test("renderColdTopicHelp returns empty for an unknown topic", () => {
    // Given / When
    const help = renderColdTopicHelp("nope", { style: false });

    // Then
    expect(help).toBe("");
  });

  test("renderColdAllHelp includes deferred built-ins and omits a TOPICS dump", () => {
    // Given / When
    const help = renderColdAllHelp({ style: false });

    // Then
    expect(help).toContain("plugin:login");
    expect(help).toContain("meta:plugin:login");
    expect(help).not.toContain("TOPICS");
  });

  test("forced style wraps headers in SGR and style false stays plain", () => {
    // Given / When
    const styled = renderColdRootHelp(undefined, { style: true });
    const plain = renderColdRootHelp(undefined, { style: false });

    // Then
    expect(styled).toContain("\x1b[");
    expect(styled).toContain("COMMON");
    expect(plain).not.toContain("\x1b[");
    expect(plain).toContain("COMMON");
  });
});
