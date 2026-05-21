import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { parseLandofile } from "../../src/landofile/parser.ts";

const parse = (content: string) =>
  Effect.runPromise(parseLandofile({ file: ".lando.yml", content, cwd: "/tmp" }));

describe("parseLandofile — quote-aware comment stripping (bugbot PR#28 finding 1)", () => {
  test("preserves # inside double-quoted string value", async () => {
    const result = await parse('name: "foo # bar"\n');
    expect((result as Record<string, unknown>).name).toBe("foo # bar");
  });

  test("preserves # inside single-quoted string value", async () => {
    const result = await parse("name: 'has # in it'\n");
    expect((result as Record<string, unknown>).name).toBe("has # in it");
  });

  test("still strips a trailing unquoted comment", async () => {
    const result = await parse("name: foo # trailing comment\n");
    expect((result as Record<string, unknown>).name).toBe("foo");
  });

  test("strips trailing comment on an unquoted value alongside a preserved quoted sibling", async () => {
    const result = await parse(["name: myapp # project name", 'runtime: "4 # not a comment"'].join("\n"));
    const r = result as Record<string, unknown>;
    expect(r.name).toBe("myapp");
    expect(r.runtime).toBe("4 # not a comment");
  });

  test("does not strip a bare # at column 0 (handled by existing full-line comment guard)", async () => {
    const result = await parse("# full line comment\nname: myapp\n");
    expect((result as Record<string, unknown>).name).toBe("myapp");
  });
});
