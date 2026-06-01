import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { writeFormattedOutput } from "../../../scripts/_codegen-output.ts";

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("writeFormattedOutput", () => {
  test("writes content and runs biome check --write on the output", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "lando-codegen-output-"));
    const output = join(tempRoot, "generated.ts");

    await writeFormattedOutput(output, "export const value={name:'demo'}\n");

    expect(await readFile(output, "utf8")).toBe('export const value = { name: "demo" };\n');
  });
});
