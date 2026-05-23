import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { rewriteScenarioSourceMappedOutput } from "../../../scripts/test-reporters/scenario-source-mapper.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(import.meta.dirname, "reporter");

const fixtureNames = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(fixturesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "fixtures")
    .map((entry) => entry.name)
    .sort();

describe("scenario source-mapper reporter", async () => {
  for (const name of await fixtureNames()) {
    test(`rewrites ${name} fixture output`, async () => {
      const input = (await readFile(resolve(fixturesRoot, name, "input.txt"), "utf8")).replaceAll(
        "<repo>",
        repoRoot,
      );
      const expected = (await readFile(resolve(fixturesRoot, name, "expected.txt"), "utf8")).replaceAll(
        "<repo>",
        repoRoot,
      );

      expect(rewriteScenarioSourceMappedOutput(input, { repoRoot })).toBe(expected);
    });
  }

  test("can be disabled for raw bun test output", async () => {
    const input = (await readFile(resolve(fixturesRoot, "single-frame", "input.txt"), "utf8")).replaceAll(
      "<repo>",
      repoRoot,
    );

    expect(rewriteScenarioSourceMappedOutput(input, { repoRoot, disabled: true })).toBe(input);
  });

  test("keeps the re-run command as the failure block's last line", async () => {
    const input = (await readFile(resolve(fixturesRoot, "single-frame", "input.txt"), "utf8")).replaceAll(
      "<repo>",
      repoRoot,
    );

    const output = rewriteScenarioSourceMappedOutput(input, { repoRoot });
    const failureBlock = output.split("\n\n").find((block) => block.includes("(fail) source-map-guide:runs"));

    expect(failureBlock?.split("\n").at(-1)).toBe(
      "Re-run: bun run docs:scenario source-map-guide --scenario runs",
    );
  });
});
