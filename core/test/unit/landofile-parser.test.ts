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

describe("parseLandofile — apostrophe-in-unquoted-scalar regression (bugbot PR#138)", () => {
  test("apostrophe in unquoted value is literal — trailing comment is stripped", async () => {
    const result = await parse("description: it's a test # comment\n");
    expect((result as Record<string, unknown>).description).toBe("it's a test");
  });

  test("apostrophe as last value char before comment — stripped correctly", async () => {
    const result = await parse("description: it's # comment\n");
    expect((result as Record<string, unknown>).description).toBe("it's");
  });

  test("embedded double-quotes in unquoted value — trailing comment stripped without quote tracking", async () => {
    const result = await parse('description: she said "hi" # comment\n');
    expect((result as Record<string, unknown>).description).toBe('she said "hi"');
  });

  test("double-quoted value with apostrophe and embedded hash — only tail comment is stripped", async () => {
    const result = await parse('description: "it\'s a # not comment" # tail\n');
    expect((result as Record<string, unknown>).description).toBe("it's a # not comment");
  });

  test("plain unquoted value without apostrophes — trailing comment is stripped", async () => {
    const result = await parse("description: regular value # trailing\n");
    expect((result as Record<string, unknown>).description).toBe("regular value");
  });
});

describe("parseLandofile — comment-after-colon regression (bugbot PR#138 finding 2)", () => {
  test("comment-only value after key is treated as empty (allows nested block)", async () => {
    const result = await parse(["services: # the services", "  web:", "    type: node"].join("\n"));
    const services = (result as Record<string, unknown>).services as Record<string, unknown>;
    expect(services).toBeDefined();
    const web = services.web as Record<string, unknown>;
    expect(web.type).toBe("node");
  });

  test("comment-only value with no nested block becomes an empty object", async () => {
    const result = await parse("services: # nothing here\n");
    expect((result as Record<string, unknown>).services).toEqual({});
  });

  test("comment-only value with no whitespace between colon and hash also becomes empty", async () => {
    const result = await parse(["services:# no space", "  web:", "    type: node"].join("\n"));
    const services = (result as Record<string, unknown>).services as Record<string, unknown>;
    expect(services.web).toEqual({ type: "node" });
  });
});
