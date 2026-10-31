import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { selectAffectedTests } from "../../../scripts/test-affected.ts";
import { collectTestInventory, staleTestOwners, testOwnership } from "../../../scripts/test-ownership.ts";
import { collectShardedTestFiles } from "../../../scripts/test-shards.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const put = async (root: string, path: string, content = "export {};\n"): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};
const fixture = async (arrayForm = false): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "test-ownership-"));
  roots.push(root);
  const patterns = ["new-package", "plugins/*"];
  await put(
    root,
    "package.json",
    JSON.stringify({ workspaces: arrayForm ? patterns : { packages: patterns } }),
  );
  await put(root, "new-package/package.json", '{"name":"@demo/new"}');
  await put(root, "plugins/new-plugin/package.json", '{"name":"@demo/plugin"}');
  await put(root, "new-package/test/new.test.ts");
  await put(root, "plugins/new-plugin/test/new.test.ts");
  await put(root, "scripts/colocated.test.ts");
  return root;
};

test.each([false, true])("discovers new workspaces and scripts with array-form=%s", async (arrayForm) => {
  const root = await fixture(arrayForm);
  await put(root, "node_modules/vendor/hidden.test.ts");
  await put(root, "new-package/dist/generated.test.ts");
  await put(root, "test/scenarios/generated/guides/example.test.ts");
  const inventory = await collectTestInventory(root);
  expect(inventory.map((entry) => entry.path)).toEqual([
    "new-package/test/new.test.ts",
    "plugins/new-plugin/test/new.test.ts",
    "scripts/colocated.test.ts",
    "test/scenarios/generated/guides/example.test.ts",
  ]);
  expect(await collectShardedTestFiles(root)).toEqual([
    "new-package/test/new.test.ts",
    "plugins/new-plugin/test/new.test.ts",
    "scripts/colocated.test.ts",
  ]);
});

test("discovers arbitrarily nested workspace roots without a hardcoded package list", async () => {
  const root = await fixture();
  await put(root, "package.json", '{"workspaces":["packages/deep/*"]}');
  await put(root, "packages/deep/new/package.json", '{"name":"@demo/deep"}');
  await put(root, "packages/deep/new/test/nested.test.ts");
  // Remove the original unregistered package test trees before checking this fixture.
  await rm(join(root, "new-package"), { recursive: true });
  await rm(join(root, "plugins"), { recursive: true });
  expect(await collectShardedTestFiles(root)).toEqual([
    "packages/deep/new/test/nested.test.ts",
    "scripts/colocated.test.ts",
  ]);
});

test("rejects an unregistered workspace test and an unowned integration suite", async () => {
  const root = await fixture();
  await put(root, "forgotten/test/lost.test.ts");
  await put(root, "new-package/test/live.integration.test.ts");
  await expect(collectTestInventory(root)).rejects.toThrow(
    "Tests without an execution owner:\nforgotten/test/lost.test.ts\nnew-package/test/live.integration.test.ts",
  );
});

test("affected selection honors the supplied workspace root when eligibility is omitted", async () => {
  const root = await fixture();
  const child = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const selection = await selectAffectedTests({ root, changed: ["new-package/test/new.test.ts"] });
  expect(selection.eligibleCount).toBe(3);
  expect(selection.selected).toEqual(["new-package/test/new.test.ts"]);
});

test("keeps fake desktop cases in PR units and records live desktop as a coverage gap", () => {
  expect(testOwnership("plugins\\provider-podman\\test\\desktop.test.ts")?.owner).toBe("unit");
  const live = testOwnership("plugins/provider-podman/test/desktop.integration.test.ts");
  expect(live?.owner).toBe("manual");
  expect(live?.note).toContain("LANDO_TEST_PODMAN_DESKTOP_SOCKET");
  expect(live?.note).toContain("no desktop acceptance");
  expect(testOwnership("../core/test/example.test.ts")).toBeUndefined();
  // The provider/service CI globs select direct children, not nested integration files.
  expect(testOwnership("plugins/provider-lando/test/nested/new.integration.test.ts")).toBeUndefined();
  expect(testOwnership("plugins/service-lando/test/nested/new.integration.test.ts")).toBeUndefined();
});

test("keeps dedicated docs, helper, nightly, library and recipe owners out of PR units", () => {
  const cases = [
    ["docs/test/frames.test.ts", "docs"],
    ["core/test/container-helper/helper.integration.test.ts", "container-helper"],
    ["core/test/scripts/codegen-ci.test.ts", "nightly"],
    ["core/test/library/api.test.ts", "library"],
    ["core/test/recipes/node.test.ts", "recipes"],
  ] as const;
  for (const [path, owner] of cases) expect(testOwnership(path)?.owner).toBe(owner);
  expect(testOwnership("plugins/provider-lando/test/contract.integration.test.ts")?.note).toContain(
    "Mixed suite",
  );
});

test("detects stale explicit ownership after a suite is renamed or removed", async () => {
  const inventory = await collectTestInventory();
  const paths = inventory.map((entry) => entry.path);
  expect(staleTestOwners(paths)).toEqual([]);
  expect(staleTestOwners(paths.filter((path) => !path.endsWith("/desktop.integration.test.ts")))).toEqual([
    "plugins/provider-podman/test/desktop.integration.test.ts",
  ]);
});
