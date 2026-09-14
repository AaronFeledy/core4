import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePerformanceStores } from "../../../scripts/workflow-performance-stores.ts";

test("refuses a replaced sample root and preserves unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "perf-owner-"));
  const stores = await acquirePerformanceStores(root, "owned");
  const evidence = join(root, "unrelated.log");
  await writeFile(evidence, "retained");
  await rename(stores.sampleRoot, `${stores.sampleRoot}-original`);
  await symlink(root, stores.sampleRoot);
  try {
    await expect(stores.assertOwned()).rejects.toThrow("Ownership changed");
    expect(await Bun.file(evidence).text()).toBe("retained");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stores.runtimeRoot, { recursive: true, force: true });
  }
});

test("rejects sample keys that escape their owned parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "perf-owner-"));
  try {
    await expect(acquirePerformanceStores(root, "../../escape")).rejects.toThrow("direct child");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
