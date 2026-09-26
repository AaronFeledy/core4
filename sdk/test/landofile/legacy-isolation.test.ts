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
    const content = await Bun.file(`${FIXTURES}/kitchen-sink.lando.yml`).text();

    expect(Exit.isFailure(parseV4(content))).toBe(true);
    expect(Exit.isSuccess(parseLegacy(content))).toBe(true);
  });

  test("the Lando 3 global config carries no Lando 3 syntax beyond quoted keys", async () => {
    // Quoted mapping keys are ordinary YAML that both dialects read the same
    // way, so this fixture no longer separates them. What still separates them
    // is Lando 3 tag data, which only the legacy parser produces.
    const content = await Bun.file(`${FIXTURES}/kitchen-sink.config.yml`).text();
    const legacy = parseLegacy(content);
    const v4 = parseV4(content);

    expect(Exit.isSuccess(legacy)).toBe(true);
    expect(Exit.isSuccess(v4)).toBe(true);
    if (Exit.isSuccess(legacy)) expect(legacy.value.tags).toEqual([]);
    if (Exit.isSuccess(v4)) {
      const plugins = (v4.value as { readonly plugins?: Record<string, unknown> }).plugins;
      expect(plugins?.["@lando/php"]).toBe("/home/me/dev/php");
    }
  });

  test("v4 accepts block scalars while still rejecting flow maps and unquoted expressions", () => {
    const rejected = ["a:\n  b: {c: d}\n", "a: ${SOME_VAR}\n"];

    for (const content of rejected) {
      expect(Exit.isFailure(parseV4(content))).toBe(true);
      expect(Exit.isSuccess(parseLegacy(content))).toBe(true);
    }
    const blockScalar = "a: |\n  line\n";
    expect(Exit.isSuccess(parseV4(blockScalar))).toBe(true);
    expect(Exit.isSuccess(parseLegacy(blockScalar))).toBe(true);
  });

  test("legacy mode keeps a tag pointing at a missing file as data instead of reading it", () => {
    const exit = parseLegacy("services:\n  web:\n    entrypoint: !load ./no/such/script.sh\n");

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.tags.map((occurrence) => occurrence.tag)).toEqual(["!load"]);
    }
  });
});
