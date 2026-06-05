import { describe, expect, test } from "bun:test";

import { isCompiledCliEntryPath } from "../../src/cli/run.ts";

describe("compiled CLI entry detection", () => {
  test("detects Bun virtual filesystem entries", () => {
    expect(isCompiledCliEntryPath("/$bunfs/root/lando.ts", "/usr/local/bin/lando")).toBe(true);
  });

  test("detects executable-path entries on platforms where import.meta.url points at the binary", () => {
    expect(isCompiledCliEntryPath("/opt/lando/bin/lando", "/opt/lando/bin/lando")).toBe(true);
  });

  test("does not treat source TypeScript entries as compiled", () => {
    expect(isCompiledCliEntryPath("/repo/core/bin/lando.ts", "/opt/lando/bin/lando")).toBe(false);
  });
});
