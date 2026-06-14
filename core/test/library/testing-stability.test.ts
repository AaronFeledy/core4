import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

describe("@lando/core/testing stability policy", () => {
  test("source comment declares testing stable on the next channel", async () => {
    const source = await readFile(new URL("../../src/testing/index.ts", import.meta.url), "utf8");

    expect(source).toMatch(/@lando\/core\/testing[\s\S]{0,240}stable[\s\S]{0,80}next/i);
  });

  test("embedding spec separates testing stability from unstable docs surfaces", async () => {
    const spec = await readFile(new URL("../../../spec/09-embedding.md", import.meta.url), "utf8");

    expect(spec).toMatch(/@lando\/core\/testing[\s\S]{0,240}stable[\s\S]{0,80}`next` channel/i);
    expect(spec).toMatch(/@lando\/core\/docs\/components[\s\S]{0,160}unstable until v4\.0\.0 GA/i);
    expect(spec).toMatch(/@lando\/core\/docs\/redactions[\s\S]{0,160}unstable until v4\.0\.0 GA/i);
  });
});
