#!/usr/bin/env bun
import { relative, resolve } from "node:path";
import { collectManifests } from "./boundary/graph.ts";
import { PROVIDER_ACCEPTANCE_CELLS } from "./provider-matrix-plan.ts";
import { checkInventoryOwnership } from "./test-ownership-check.ts";
import {
  TEST_ROOT,
  collectTestFiles,
  isBunTest,
  isIntegrationTest,
  normalizeTestPath,
  resolveTestSelection,
} from "./test-selection-files.ts";
import { TEST_SELECTIONS, type TestSelection, hasNameFilter, selectionMatches } from "./test-selections.ts";

export const MANUAL_TESTS: Readonly<Record<string, string>> = {
  "core/test/cli/shell-tty.integration.test.ts": "LANDO_TEST_SHELL_TTY=1 and a real terminal",
  "docs/test/rendered-guide.integration.test.ts": "Astro build and generated transcript mutation",
  "engine/test/runtime/managed-provider-machine.integration.test.ts":
    "LANDO_TEST_PODMAN_MACHINE_TEARDOWN=1; destructive machine teardown",
  "plugins/provider-podman/test/desktop.integration.test.ts":
    "Native darwin/win32 and LANDO_TEST_PODMAN_DESKTOP_SOCKET",
  "plugins/proxy-traefik/test/router-bind-network.integration.test.ts":
    "Isolated host networking and LANDO_TEST_ROUTER_BIND_NETWORK=1",
};

export interface MatrixTestCheck {
  readonly id: string;
  readonly command: readonly string[];
  readonly advisory?: boolean;
}
const matrixChecks: readonly MatrixTestCheck[] = PROVIDER_ACCEPTANCE_CELLS.flatMap((cell) =>
  cell.checks.map((check) => ({
    id: `provider-matrix:${cell.id}:${check.id}`,
    command: check.command,
    advisory: cell.setup === "advisory" || !cell.releaseBlocking,
  })),
);

export interface TestInventoryOptions {
  readonly root?: string;
  readonly selections?: readonly TestSelection[];
  readonly planChecks?: readonly MatrixTestCheck[];
  readonly manual?: Readonly<Record<string, string>>;
  readonly workflowRoot?: string;
}
export interface TestInventoryEntry {
  readonly path: string;
  readonly owners: readonly string[];
  readonly needs?: string;
}
export type TestOwnershipCode =
  | "UNOWNED"
  | "UNKNOWN_LOCATION"
  | "STALE_SELECTOR"
  | "UNBOUND_SELECTION"
  | "RAW_BUN_TEST"
  | "MANUAL_SELECTED"
  | "MANUAL_STALE";
export interface TestOwnershipIssue {
  readonly code: TestOwnershipCode;
  readonly paths: readonly string[];
  readonly remediation: string;
}

export const isUnitTest = (
  input: string,
  selections: readonly TestSelection[] = TEST_SELECTIONS,
): boolean => {
  const path = normalizeTestPath(input);
  return (
    !path.split("/").some((part) => part === ".." || part === "") &&
    isBunTest(path) &&
    !isIntegrationTest(path) &&
    !selections.some(
      (selection) =>
        selection.unit === "exclude" &&
        !hasNameFilter(selection.args ?? []) &&
        selectionMatches(selection, path),
    )
  );
};

const inventorySnapshot = async (options: TestInventoryOptions) => {
  const root = options.root ?? TEST_ROOT;
  const selections: readonly TestSelection[] = options.selections ?? TEST_SELECTIONS;
  const manual = options.manual ?? MANUAL_TESTS;
  const checks = options.planChecks ?? matrixChecks;
  const workspaces = (await collectManifests(root)).map((path) =>
    normalizeTestPath(relative(root, resolve(path, ".."))),
  );
  const files = await collectTestFiles(root);
  const unknown = files.filter(
    (path) =>
      !workspaces.some((workspace) => path.startsWith(`${workspace}/test/`)) &&
      !path.startsWith("scripts/") &&
      !(path.startsWith("core/container-helper/") && path.endsWith("_test.go")),
  );
  const unknownPaths = new Set(unknown);
  const resolved = selections.map((selection) => ({
    selection,
    files: new Set(resolveTestSelection(selection, files)),
  }));
  const entries = files.map((path): TestInventoryEntry => {
    const selected = resolved.filter((entry) => entry.files.has(path)).map((entry) => entry.selection);
    const owners = selected
      .filter((selection) => !hasNameFilter(selection.args ?? []))
      .map((selection) => selection.id);
    for (const check of checks) {
      if (
        !check.advisory &&
        check.command[0] === "bun" &&
        check.command[1] === "test" &&
        !hasNameFilter(check.command) &&
        check.command.slice(2).some((arg) => !arg.startsWith("-") && normalizeTestPath(arg) === path)
      )
        owners.push(check.id);
    }
    if (!unknownPaths.has(path) && isUnitTest(path, selections)) owners.push("unit");
    if (path in manual && owners.length === 0) owners.push("manual");
    const needs = [...new Set(selected.flatMap((selection) => (selection.needs ? [selection.needs] : [])))];
    if (manual[path]) needs.push(manual[path]);
    return {
      path,
      owners: [...new Set(owners)].sort(),
      ...(needs.length ? { needs: needs.join("; ") } : {}),
    };
  });
  return { entries, unknown, files, selections, manual, root };
};

export const collectTestInventory = async (
  options: TestInventoryOptions = {},
): Promise<readonly TestInventoryEntry[]> => (await inventorySnapshot(options)).entries;

export const checkTestOwnership = async (options: TestInventoryOptions = {}) => {
  const snapshot = await inventorySnapshot(options);
  const issues = await checkInventoryOwnership({
    ...snapshot,
    workflowRoot: options.workflowRoot ?? resolve(snapshot.root, ".github/workflows"),
  });
  return { entries: snapshot.entries, issues };
};

export const formatOwnershipIssue = (issue: TestOwnershipIssue): string =>
  `${issue.code}: ${issue.paths.join(", ")}\n  ${issue.remediation}`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check"))
    throw new Error("usage: bun run test:inventory [--check]");
  const { entries, issues } = await checkTestOwnership();
  if (issues.length) {
    for (const issue of issues) console.error(formatOwnershipIssue(issue));
    process.exitCode = 1;
  } else if (args[0] === "--check") {
    console.log(
      `Test ownership checked: ${entries.length} files; all selections bound; no ownership errors.`,
    );
  } else {
    const owners = [...new Set(entries.flatMap((entry) => entry.owners))].sort();
    console.log(
      JSON.stringify(
        {
          counts: Object.fromEntries(
            owners.map((owner) => [owner, entries.filter((entry) => entry.owners.includes(owner)).length]),
          ),
          tests: entries,
        },
        null,
        2,
      ),
    );
  }
}
