import { expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectImportBoundaryViolations } from "@lando/sdk/test";

it("keeps production imports inside the SDK-only workspace boundary", async () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const violations = await collectImportBoundaryViolations({ packageRoot, alwaysAllowed: ["@lando/sdk"] });
  expect(violations).toEqual([]);
});

it("detects forbidden core, engine and container-runtime imports", async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), "lando-actions-boundary-"));
  try {
    await mkdir(join(packageRoot, "src"));
    await writeFile(
      join(packageRoot, "src/index.ts"),
      [
        'import "@lando/core";',
        'export * from "@lando/engine/runtime";',
        'import "@lando/container-runtime";',
      ].join("\n"),
    );
    const violations = await collectImportBoundaryViolations({
      packageRoot,
      alwaysAllowed: ["@lando/sdk"],
      packageJson: { name: "@lando/github-actions", dependencies: { "@lando/sdk": "workspace:*" } },
    });
    expect(violations.map((violation) => violation.specifier).sort()).toEqual([
      "@lando/container-runtime",
      "@lando/core",
      "@lando/engine/runtime",
    ]);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});
