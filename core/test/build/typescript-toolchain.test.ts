import { resolve } from "node:path";

import { expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

test("package scripts resolve tsc to TypeScript 7", async () => {
  // Given: Bun links the first `tsc` bin by package folder name, and the TypeScript 6 API
  // package also ships one.
  const tsc = Bun.which("tsc", { PATH: resolve(repoRoot, "node_modules/.bin") });
  if (tsc === null) throw new Error("node_modules/.bin has no tsc; run bun install.");

  // When
  const child = Bun.spawn([tsc, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

  // Then
  expect(code).toBe(0);
  expect(stdout).toMatch(/^Version 7\./);
});
