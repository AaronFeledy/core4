import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const cliRoot = resolve(import.meta.dirname, "../../src/cli");

const CARVE_OUTS = new Set([resolve(cliRoot, "oclif/pre-renderer.ts")]);

const DIRECT_WRITE = /\bconsole\.(log|error|warn|info|debug)\b|\bprocess\.(stdout|stderr)\.write\b/;

const collectTsFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsFiles(full)));
      continue;
    }
    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
};

describe("CLI command-boundary direct-write canary (US-157 zero-state)", () => {
  test("no console.* or process.std*.write outside the fast-path carve-outs", async () => {
    const files = await collectTsFiles(cliRoot);
    const offenders: string[] = [];
    for (const file of files) {
      if (CARVE_OUTS.has(file)) continue;
      const source = await Bun.file(file).text();
      source.split("\n").forEach((line, index) => {
        if (DIRECT_WRITE.test(line)) {
          offenders.push(`${relative(cliRoot, file)}:${(index + 1).toString()}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
