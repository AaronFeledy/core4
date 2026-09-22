import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { parseLandofile, parseLegacyLandofile } from "@lando/sdk/landofile";

const FIXTURES = `${import.meta.dir}/../fixtures/lando3`;
const FILE = "/app/.lando.yml";

const parseLegacy = (content: string) =>
  Effect.runSync(Effect.exit(parseLegacyLandofile({ mode: "legacy", file: FILE, content })));

const parseV4 = (content: string) =>
  Effect.runSync(Effect.exit(parseLandofile({ file: FILE, content, cwd: "/app" })));

describe("legacy mode leaves the v4 parser restrictions alone", () => {
  test("v4 still rejects the Lando 3 corpus that legacy mode accepts", async () => {
    for (const fixture of ["kitchen-sink.lando.yml", "kitchen-sink.config.yml"]) {
      const content = await Bun.file(`${FIXTURES}/${fixture}`).text();

      expect(Exit.isFailure(parseV4(content))).toBe(true);
      expect(Exit.isSuccess(parseLegacy(content))).toBe(true);
    }
  });

  test("v4 still rejects populated flow maps, block scalars, and unquoted expressions", () => {
    const rejected = ["a:\n  b: {c: d}\n", "a: |\n  line\n", "a: ${SOME_VAR}\n"];

    for (const content of rejected) {
      expect(Exit.isFailure(parseV4(content))).toBe(true);
      expect(Exit.isSuccess(parseLegacy(content))).toBe(true);
    }
  });

  test("legacy mode keeps a tag pointing at a missing file as data instead of reading it", () => {
    const exit = parseLegacy("services:\n  web:\n    entrypoint: !load ./no/such/script.sh\n");

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.tags.map((occurrence) => occurrence.tag)).toEqual(["!load"]);
    }
  });
});
