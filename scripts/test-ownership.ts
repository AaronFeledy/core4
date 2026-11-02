#!/usr/bin/env bun
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { collectManifests } from "./boundary/graph.ts";

const ROOT = resolve(import.meta.dirname, "..");
const normalize = (path: string): string => path.replaceAll("\\", "/").replace(/^\.\//u, "");
const TEST_FILE = /(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/u;
const GO_TEST_FILE = /_test\.go$/u;
const INTEGRATION_FILE = /\.integration[._](?:test|spec)\.[cm]?[jt]sx?$/u;
const isTestFile = (path: string): boolean => TEST_FILE.test(path) || GO_TEST_FILE.test(path);
const ignoredDirectories = new Set([".git", "node_modules", "dist", ".astro", "provider-diagnostics"]);

export const FAKE_CLIENT_PROVIDER_TESTS: readonly string[] = [
  "plugins/provider-lando/test/contract.integration.test.ts",
  "plugins/provider-docker/test/contract.integration.test.ts",
  "plugins/provider-podman/test/contract.integration.test.ts",
];

// These files have no live-provider prerequisite. A .integration suffix alone
// must not keep local fixtures and cross-process state tests out of PR coverage.
export const LOCAL_INTEGRATION_TESTS: readonly string[] = [
  "core/test/cli/host-terminal.integration.test.ts",
  "core/test/lifecycle/subscribers.integration.test.ts",
  "plugins/provider-docker/test/applied-state.integration.test.ts",
  "plugins/provider-docker/test/cross-process.integration.test.ts",
  "plugins/provider-lando/test/applied-state.integration.test.ts",
  "plugins/provider-lando/test/cross-process.integration.test.ts",
  "plugins/provider-lando/test/ensure-runtime.integration.test.ts",
  "plugins/provider-lando/test/exec-env-contract.integration.test.ts",
  "plugins/provider-podman/test/applied-state.integration.test.ts",
  "plugins/service-lando/test/php-prerequisites-rebuild.integration.test.ts",
];

export const NIGHTLY_TIER_TESTS: readonly string[] = [
  "core/test/scripts/codegen-ci.test.ts",
  "core/test/build/linux-acceptance-criteria-10-14.test.ts",
];

// An explicit manual owner records a coverage gap; it never means CI executes it.
// New integration files must acquire an owner here or in a dedicated job rule.
export const MANUAL_TESTS: Readonly<Record<string, string>> = {
  "container-runtime/test/ephemeral-data-helpers.integration.test.ts":
    "Requires LANDO_TEST_DOCKER_SOCKET; no current CI invocation selects this file.",
  "container-runtime/test/listener-observation.integration.test.ts":
    "Requires a live LANDO_TEST_PODMAN_SOCKET and docker.io/library/redis:7 (pulled if absent); no current CI invocation selects this file.",
  "core/test/cli/shell-tty.integration.test.ts":
    "Requires LANDO_TEST_SHELL_TTY=1 and a real terminal; no current CI invocation selects this file.",
  "core/test/cli/start-readiness.integration.test.ts":
    "Requires an answering provider socket; no current CI invocation selects this file.",
  "docs/test/rendered-guide.integration.test.ts":
    "Builds Astro and mutates generated transcripts; docs:test excludes integration files.",
  "engine/test/runtime/managed-provider-machine.integration.test.ts":
    "Destructive machine teardown requires LANDO_TEST_PODMAN_MACHINE_TEARDOWN=1; no current CI invocation selects this file.",
  "plugins/provider-podman/test/desktop.integration.test.ts":
    "Requires native darwin/win32 and LANDO_TEST_PODMAN_DESKTOP_SOCKET; Linux fake-client passes provide no desktop acceptance.",
  "plugins/provider-podman/test/host-reachability.integration.test.ts":
    "Requires an answering Podman socket; current provider jobs select only its contract and capability files.",
  "plugins/proxy-traefik/test/router-bind-network.integration.test.ts":
    "Requires isolated host networking and LANDO_TEST_ROUTER_BIND_NETWORK=1; no current CI invocation selects this file.",
};

export type TestOwner =
  | "unit"
  | "library"
  | "recipes"
  | "docs"
  | "guides"
  | "nightly"
  | "providers"
  | "services"
  | "container-helper"
  | "container-helper-go"
  | "manual";
export interface TestOwnership {
  readonly owner: TestOwner;
  readonly invocation: string;
  readonly note: string;
}
export interface TestInventoryEntry extends TestOwnership {
  readonly path: string;
}

const ownership = (owner: TestOwner, invocation: string, note: string): TestOwnership => ({
  owner,
  invocation,
  note,
});

export const testOwnership = (input: string): TestOwnership | undefined => {
  const path = normalize(input);
  if (!isTestFile(path) || path.split("/").some((part) => part === ".." || part === "")) return;
  if (GO_TEST_FILE.test(path)) {
    return path.startsWith("core/container-helper/")
      ? ownership(
          "container-helper-go",
          "ci.yml: container-helper (bun run scripts/build-container-helper.ts --test)",
          "Go tests run in the containerized Linux x64 helper builder, outside Bun. The ARM64 helper job exercises downloaded binaries, not native ARM64 Go tests.",
        )
      : undefined;
  }
  if (path in MANUAL_TESTS) return ownership("manual", `bun test ./${path}`, MANUAL_TESTS[path] ?? "");
  if (NIGHTLY_TIER_TESTS.includes(path))
    return ownership(
      "nightly",
      "nightly.yml: nightly-tier-unit-tests-linux-x64",
      "Outside PR shards; run by path when its generator changes.",
    );
  if (path.startsWith("test/scenarios/generated/guides/"))
    return ownership(
      "guides",
      "ci.yml: guide-scenarios-<platform>",
      "Derived guide scenarios; e2e cases require their opt-in runtime prerequisites.",
    );
  if (path.startsWith("core/test/library/") || path.startsWith("sdk/test/library/"))
    return ownership("library", "ci.yml: library-api-tests", "Dedicated library suite.");
  if (path.startsWith("core/test/recipes/") || path === "core/test/cli/init.canonical-recipes.test.ts")
    return ownership("recipes", "ci.yml: recipe-tests", "Dedicated recipe suite.");
  if (path === "core/test/container-helper/helper.integration.test.ts")
    return ownership(
      "container-helper",
      "ci.yml: container-helper / container-helper-arm64",
      "Requires real built Go helpers; Linux only.",
    );
  if (FAKE_CLIENT_PROVIDER_TESTS.includes(path))
    return ownership(
      "unit",
      "ci.yml: unit-tests-linux-x64-shard",
      "Mixed suite: fake clients run in shards; live/native cases can skip and also have provider job invocations.",
    );
  if (LOCAL_INTEGRATION_TESTS.includes(path))
    return ownership(
      "unit",
      "ci.yml: unit-tests-linux-x64-shard",
      "Local fixtures or subprocesses; no live provider required. Platform skips remain possible.",
    );
  if (INTEGRATION_FILE.test(path)) {
    if (
      path.startsWith("core/test/live/") ||
      /^plugins\/provider-(?:lando|docker)\/test\/[^/]+\.integration\.test\.ts$/u.test(path)
    )
      return ownership(
        "providers",
        "ci.yml: provider-integration-linux-x64",
        "File selected by provider job; live, native and opt-in cases may still skip. Selection is not an acceptance receipt.",
      );
    if (/^plugins\/service-lando\/test\/[^/]+\.integration\.test\.ts$/u.test(path))
      return ownership(
        "services",
        "ci.yml: provider-integration-linux-x64",
        "File selected by service job; architecture and opt-in prerequisites can still cause skips.",
      );
    return;
  }
  if (path.startsWith("docs/test/"))
    return ownership(
      "docs",
      "ci.yml: docs-build (bun run docs:test)",
      "Dedicated Astro-owned suite; excluded from unit shards.",
    );
  if (path.startsWith("scripts/") || path.includes("/test/"))
    return ownership(
      "unit",
      "ci.yml: unit-tests-linux-x64-shard",
      "Local suite; a selected file may contain conditional live, compiled or platform cases. Inspect skips before claiming acceptance.",
    );
  return;
};

export const collectTestInventory = async (root = ROOT): Promise<readonly TestInventoryEntry[]> => {
  const workspaceRoots = (await collectManifests(root)).map((path) =>
    normalize(relative(root, resolve(path, ".."))),
  );
  const entries: TestInventoryEntry[] = [];
  const failures: string[] = [];
  const symlinks: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await walk(path);
      } else if (entry.isSymbolicLink() && isTestFile(entry.name)) {
        symlinks.push(path);
      } else if (entry.isFile() && isTestFile(entry.name)) {
        const discovered =
          workspaceRoots.some((workspace) => path.startsWith(`${workspace}/test/`)) ||
          path.startsWith("scripts/") ||
          path.startsWith("test/scenarios/generated/guides/") ||
          (GO_TEST_FILE.test(path) && path.startsWith("core/container-helper/"));
        const owner = discovered ? testOwnership(path) : undefined;
        if (owner) entries.push({ path, ...owner });
        else failures.push(path);
      }
    }
  };
  await walk("");
  if (symlinks.length)
    throw new Error(
      `Test-file symlinks are not supported; use regular test files:\n${symlinks.sort().join("\n")}`,
    );
  if (failures.length) throw new Error(`Tests without an execution owner:\n${failures.sort().join("\n")}`);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

export const staleTestOwners = (paths: readonly string[]): readonly string[] => {
  const found = new Set(paths);
  return [
    ...FAKE_CLIENT_PROVIDER_TESTS,
    ...LOCAL_INTEGRATION_TESTS,
    ...NIGHTLY_TIER_TESTS,
    ...Object.keys(MANUAL_TESTS),
    "core/test/container-helper/helper.integration.test.ts",
    "core/test/cli/init.canonical-recipes.test.ts",
  ]
    .filter((path) => !found.has(path))
    .sort();
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
    throw new Error("usage: bun run test:inventory [--check]");
  const entries = await collectTestInventory();
  const stale = staleTestOwners(entries.map((entry) => entry.path));
  if (stale.length) throw new Error(`Stale explicit test owners:\n${stale.join("\n")}`);
  if (args[0] === "--check")
    console.log(`Test ownership checked: ${entries.length} files; no unowned or stale entries.`);
  else
    console.log(
      JSON.stringify(
        {
          counts: Object.fromEntries(
            [...new Set(entries.map((entry) => entry.owner))]
              .sort()
              .map((owner) => [owner, entries.filter((entry) => entry.owner === owner).length]),
          ),
          note: "Ownership records file selection, not test execution or live/native acceptance. Manual entries are known gaps.",
          tests: entries,
        },
        null,
        2,
      ),
    );
}
