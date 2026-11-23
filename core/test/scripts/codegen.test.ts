import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CODEGEN_CATALOG, resolveCodegenCommand } from "../../../scripts/codegen-catalog.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const outputsByGenerator = {
  "bundled-plugins": ["core/src/plugins/generated/bundled.ts", "core/src/plugins/generated/renderers.ts"],
  "command-registry-manifest": ["core/src/cli/generated/command-registry-manifest.ts"],
} as const;

// Each generator's inputs, including its catalog dependencies' outputs, already exist:
// the test preload refuses to run without generated modules.
const runGenerator = async (id: string): Promise<void> => {
  const entry = CODEGEN_CATALOG.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Codegen catalog has no ${id} entry.`);
  const command = resolveCodegenCommand(entry);
  const proc = Bun.spawn({ cmd: [...command.cmd], cwd: command.cwd, stdout: "pipe", stderr: "pipe" });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect({ id, exitCode, stdout, stderr }).toMatchObject({ exitCode: 0 });
};

const readOutputs = (paths: readonly string[]) =>
  Promise.all(paths.map((path) => readFile(resolve(repoRoot, path), "utf8")));

describe("codegen generators", () => {
  test.each(Object.entries(outputsByGenerator))(
    "%s regenerates its outputs idempotently",
    async (id, paths) => {
      await runGenerator(id);
      const first = await readOutputs(paths);
      expect(first.every((source) => source.length > 0)).toBe(true);

      await runGenerator(id);

      expect(await readOutputs(paths)).toEqual(first);
    },
  );
});
