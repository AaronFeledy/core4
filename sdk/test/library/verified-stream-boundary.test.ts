import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("@lando/sdk/verified-stream import boundary", () => {
  test("stays independent of core runtime and OCLIF", async () => {
    const source = await readFile(new URL("../../src/verified-stream/index.ts", import.meta.url), "utf8");

    expect(source).not.toContain("@lando/core");
    expect(source).not.toContain("@oclif/core");
    expect(source).not.toContain("../services/");
  });
});
