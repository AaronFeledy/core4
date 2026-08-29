import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");

const readText = async (path: string): Promise<string> => Bun.file(resolve(repoRoot, path)).text();

describe("paths primitive package promotion decision", () => {
  test("publishes a decision promoting only @lando/paths with the public shim", async () => {
    const decisions = await readText("docs/contributing/decisions.md");

    expect(decisions).toContain("## Paths primitive package promotion decision");
    expect(decisions).toContain("@lando/paths");
    expect(decisions).toContain("private: true");
    expect(decisions).toContain("paths,paths-platform,overlay,yaml-min");
    expect(decisions).toContain("@lando/core/paths");
    expect(decisions).toContain('export * from "@lando/paths"');
    expect(decisions).toContain("landofile");
    expect(decisions).toMatch(/publishes alongside/i);
  });

  test("rejects StateStore and RedactionService promotion", async () => {
    const decisions = await readText("docs/contributing/decisions.md");

    expect(decisions).toContain("Rejected: promoting `StateStore`");
    expect(decisions).toContain("Rejected: promoting `RedactionService`");
    expect(decisions).toContain("@lando/sdk/secrets");
    expect(decisions).toMatch(/fsync/i);
    expect(decisions).toMatch(/Effect service/i);
  });

  test("allows plugins to depend on @lando/paths but not @lando/core", async () => {
    const decisions = await readText("docs/contributing/decisions.md");

    expect(decisions).toMatch(/Plugins may depend on `@lando\/paths` directly/i);
    expect(decisions).toContain("always-allowed");
    expect(decisions).toContain("@lando/sdk");
    expect(decisions).toContain("@lando/container-runtime");
    expect(decisions).toMatch(/may not depend on `@lando\/core`/i);
  });
});
