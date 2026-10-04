import { expect, test } from "bun:test";

interface DecodeOutcome {
  readonly id: string;
  readonly ok: boolean;
}

const decodeCorpus = async (mode: "interpreted" | "compiled"): Promise<ReadonlyArray<DecodeOutcome>> => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      new URL("./compiled-decoders-parity-fixture.ts", import.meta.url).pathname,
      mode,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
};

test("compiled and interpreted Landofile decoders agree on the valid and invalid fixture sets", async () => {
  // Given the guide and recipe Landofiles plus the curated valid and invalid inputs,
  // decoded once by the interpreter and once with the generated decoders installed.
  const [interpreted, compiled] = await Promise.all([decodeCorpus("interpreted"), decodeCorpus("compiled")]);

  // Then both accept the same inputs, produce the same values, and report the same issues.
  expect(interpreted.filter(({ ok }) => ok).length).toBeGreaterThan(100);
  expect(interpreted.some(({ ok }) => !ok)).toBe(true);
  expect(compiled).toEqual(interpreted);
}, 60_000);
