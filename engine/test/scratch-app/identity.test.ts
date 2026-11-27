import { expect, test } from "bun:test";
import { join } from "node:path";
import { scratchIdForInstanceRoot } from "../../src/scratch-app/identity.ts";

const scratchDir = "/data/scratch";

test.each([
  ["a managed instance root", join(scratchDir, "scratch-demo-abc123", "root"), "scratch-demo-abc123"],
  ["the same shape outside the scratch directory", "/apps/scratch-demo-abc123/root", undefined],
  ["the instance directory itself", join(scratchDir, "scratch-demo-abc123"), undefined],
  ["a non-canonical id under the scratch directory", join(scratchDir, "Scratch-Demo", "root"), undefined],
])("scratchIdForInstanceRoot attributes %s", (_label, root, expected) => {
  expect(scratchIdForInstanceRoot(scratchDir, root)).toBe(expected);
});
