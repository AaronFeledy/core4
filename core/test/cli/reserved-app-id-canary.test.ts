import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const commandsDir = new URL("../../src/cli/commands", import.meta.url).pathname;

const collectTsFiles = (dir: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
};

describe("user-app command reserved-id routing", () => {
  test("no command calls LandofileService.discover directly", () => {
    const offenders = collectTsFiles(commandsDir).filter((file) =>
      readFileSync(file, "utf8").includes(".discover"),
    );

    expect(offenders).toEqual([]);
  });
});
