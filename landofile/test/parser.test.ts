import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { ComposeKeyRejectedError, LandofileParseError } from "@lando/sdk/errors";
import { parseLandofile } from "../src/parser.ts";

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;

type ParseLimits = {
  readonly maxContentBytes?: number;
  readonly maxDepth?: number;
};

const parse = (content: string, limits?: ParseLimits) => {
  const options =
    limits === undefined
      ? { file: ".lando.yml", content, cwd: "/tmp" }
      : { file: ".lando.yml", content, cwd: "/tmp", limits };

  return Effect.runPromise(parseLandofile(options));
};

const parseExit = (content: string, limits?: ParseLimits) => {
  const options =
    limits === undefined
      ? { file: ".lando.yml", content, cwd: "/tmp" }
      : { file: ".lando.yml", content, cwd: "/tmp", limits };

  return Effect.runPromiseExit(parseLandofile(options));
};

const nestedMap = (depth: number) =>
  Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}k${i}:`).join("\n");

const expectParseError = async (content: string, message: RegExp, limits?: ParseLimits) => {
  const exit = await parseExit(content, limits);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected parse to fail");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("Expected tagged failure");
  expect(failure.value).toBeInstanceOf(LandofileParseError);
  expect(failure.value.message).toMatch(message);
};

const parseFailure = async (content: string, limits?: ParseLimits): Promise<LandofileParseError> => {
  const exit = await parseExit(content, limits);
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected parse to fail");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("Expected tagged failure");
  expect(failure.value).toBeInstanceOf(LandofileParseError);
  if (!(failure.value instanceof LandofileParseError)) throw failure.value;
  return failure.value;
};

describe("parseLandofile — input caps", () => {
  test("rejects content larger than the default input-size cap", async () => {
    await expectParseError(
      `key: ${"a".repeat(DEFAULT_MAX_CONTENT_BYTES)}`,
      /Landofile exceeds the maximum input size.*1048581.*1048576/,
    );
  });

  test("accepts content under the default input-size cap", async () => {
    const result = await parse(`key: ${"a".repeat(DEFAULT_MAX_CONTENT_BYTES - 6)}`);
    expect((result as Record<string, unknown>).key).toBe("a".repeat(DEFAULT_MAX_CONTENT_BYTES - 6));
  });

  test("rejects block nesting deeper than the default depth cap", async () => {
    await expectParseError(nestedMap(DEFAULT_MAX_DEPTH + 1), /nesting depth.*64.*line 65/i);
  });

  test("accepts block nesting at the default depth cap", async () => {
    const result = await parse(nestedMap(DEFAULT_MAX_DEPTH));
    let node: unknown = result;
    for (let i = 0; i < DEFAULT_MAX_DEPTH; i += 1) {
      node = (node as Record<string, unknown>)[`k${i}`];
    }
    expect(node).toEqual({});
  });

  test("rejects inline-array nesting bombs with a LandofileParseError", async () => {
    await expectParseError(`key: ${"[".repeat(10_000)}${"]".repeat(10_000)}`, /nesting depth/i);
  });

  test("custom maxDepth rejects documents accepted by the default", async () => {
    const result = await parse(nestedMap(5));
    expect(result).toEqual({ k0: { k1: { k2: { k3: { k4: {} } } } } });
    await expectParseError(nestedMap(5), /nesting depth.*4.*line 5/i, { maxDepth: 4 });
  });

  test("custom maxContentBytes rejects documents accepted by the default", async () => {
    const content = `key: ${"a".repeat(95)}`;
    const result = await parse(content);
    expect(result).toEqual({ key: "a".repeat(95) });
    await expectParseError(content, /maximum input size.*100.*64/i, { maxContentBytes: 64 });
  });

  test("explicit default-equal limits preserve normal parse output", async () => {
    const content = ["services: # the services", "  web:", "    type: node", "mounts:", "  - {}"].join("\n");
    const defaultResult = await parse(content);
    const limitedResult = await parse(content, {
      maxContentBytes: DEFAULT_MAX_CONTENT_BYTES,
      maxDepth: DEFAULT_MAX_DEPTH,
    });

    expect(limitedResult).toEqual(defaultResult);
  });
});

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

describe("parseLandofile — double-quoted scalar escapes", () => {
  test("unescapes emitted newline, carriage return, tab, quote, and backslash sequences", async () => {
    const result = await parse('value: "line one\\nline two\\rleft\\tright\\\\\\"quoted\\""\n');
    expect((result as Record<string, unknown>).value).toBe('line one\nline two\rleft\tright\\"quoted"');
  });
});

describe("parseLandofile — empty-record list item round-trip", () => {
  test("a `- {}` sequence item parses to an empty object", async () => {
    const result = await parse(["mounts:", "  - {}"].join("\n"));
    expect((result as Record<string, unknown>).mounts).toEqual([{}]);
  });

  test("a `- {}` item interleaves with populated map items", async () => {
    const result = await parse(["mounts:", "  - {}", "  - target: /app"].join("\n"));
    expect((result as Record<string, unknown>).mounts).toEqual([{}, { target: "/app" }]);
  });

  test("non-empty inline objects remain rejected", async () => {
    await expectParseError(["mounts:", "  - {a: 1}"].join("\n"), /Inline objects are not supported/);
  });

  test("a flow-empty `{}` map value parses to an empty object", async () => {
    const result = await parse("config: {}\n");
    expect((result as Record<string, unknown>).config).toEqual({});
  });
});

describe("parseLandofile — native YAML references", () => {
  test("resolves scalar, mapping, and sequence aliases before schema decoding", async () => {
    const content = [
      "sharedName: &sharedName worker",
      "defaults: &defaults",
      "  image: node:22",
      "  environment:",
      "    MODE: shared",
      "sharedPorts: &sharedPorts",
      "  - 8080:80",
      "services:",
      "  web:",
      "    <<: *defaults",
      "    image: node:24",
      "    ports: *sharedPorts",
      "  worker: *defaults",
      "aliasName: *sharedName",
    ].join("\n");

    expect(await parse(content)).toEqual({
      sharedName: "worker",
      defaults: { image: "node:22", environment: { MODE: "shared" } },
      sharedPorts: ["8080:80"],
      services: {
        web: {
          image: "node:24",
          environment: { MODE: "shared" },
          ports: ["8080:80"],
        },
        worker: { image: "node:22", environment: { MODE: "shared" } },
      },
      aliasName: "worker",
    });
  });

  test("uses YAML merge precedence for sequences and explicit keys regardless of order", async () => {
    const content = [
      "first: &first",
      "  winner: first",
      "  fromFirst: true",
      "second: &second",
      "  winner: second",
      "  fromSecond: true",
      "merged:",
      "  winner: explicit",
      "  <<: [*first, *second]",
    ].join("\n");

    expect(await parse(content)).toEqual({
      first: { winner: "first", fromFirst: true },
      second: { winner: "second", fromSecond: true },
      merged: { winner: "explicit", fromFirst: true, fromSecond: true },
    });
  });

  test.each([
    ["unknown alias", "value: *missing", /Unknown YAML alias/, 1, 8],
    ["forward alias", "value: *later\nlater: &later resolved", /Unknown YAML alias/, 1, 8],
    ["unknown alias in a sequence mapping", "items:\n  - name: *missing", /Unknown YAML alias/, 2, 11],
    ["recursive alias graph", "value: &loop\n  self: *loop", /recursive YAML alias graph/i, 2, 9],
    [
      "invalid merge target",
      "scalar: &scalar value\nmerged:\n  <<: *scalar",
      /YAML merge target must be a mapping/i,
      3,
      7,
    ],
    ["duplicate anchor", "first: &dup one\nsecond: &dup two", /Duplicate YAML anchor/, 2, 9],
  ] as const)("rejects a %s with location and remediation", async (_name, content, message, line, column) => {
    const error = await parseFailure(content);

    expect(error).not.toBeInstanceOf(ComposeKeyRejectedError);
    expect(error).toMatchObject({ _tag: "LandofileParseError", line, column });
    expect(error.message).toMatch(message);
    expect(error.remediation).toMatch(/anchor|alias|mapping/i);
  });

  test("resolves aliases in inline sequences written with surrounding whitespace", async () => {
    const content = ["base: &base shared", "tight: [*base]", "spaced: [ *base , *base ]"].join("\n");

    expect(await parse(content)).toEqual({
      base: "shared",
      tight: ["shared"],
      spaced: ["shared", "shared"],
    });
  });

  test("merges an alias whose anchor is a sequence of mappings", async () => {
    const content = [
      "first: &first",
      "  winner: first",
      "second: &second",
      "  winner: second",
      "  fromSecond: true",
      "both: &both",
      "  - *first",
      "  - *second",
      "merged:",
      "  <<: *both",
    ].join("\n");

    expect((await parse(content)) as Record<string, unknown>).toMatchObject({
      merged: { winner: "first", fromSecond: true },
    });
  });

  test("merges a merge key that opens a sequence item", async () => {
    const content = [
      "defaults: &defaults",
      "  image: node:22",
      "  restart: always",
      "services:",
      "  - <<: *defaults",
      "    name: web",
      "    image: node:24",
    ].join("\n");

    expect(await parse(content)).toEqual({
      defaults: { image: "node:22", restart: "always" },
      services: [{ image: "node:24", restart: "always", name: "web" }],
    });
  });

  test("keeps a hash inside an anchored quoted scalar", async () => {
    const content = ['original: &shared "foo # bar"', "copied: *shared"].join("\n");

    expect(await parse(content)).toEqual({ original: "foo # bar", copied: "foo # bar" });
  });

  test("resolves anchor names containing punctuation", async () => {
    const content = ["base: &service.defaults value", "copy: *service.defaults"].join("\n");

    expect(await parse(content)).toEqual({ base: "value", copy: "value" });
  });

  test("reports the alias column after extra sequence-item whitespace", async () => {
    const error = await parseFailure("items:\n  -   *missing");

    expect(error).toMatchObject({ _tag: "LandofileParseError", line: 2, column: 7 });
  });

  test("preserves mappings that resemble the internal alias representation", async () => {
    const content = ["payload:", "  _tag: YamlAlias", "  name: user-data", "  line: 1", "  column: 1"].join(
      "\n",
    );

    expect(await parse(content)).toEqual({
      payload: { _tag: "YamlAlias", name: "user-data", line: 1, column: 1 },
    });
  });
});

describe("parseLandofile — alias expansion budget", () => {
  const nestedAliasBomb = (levels: number, fanOut: number): string =>
    [
      "level0: &level0 leaf",
      ...Array.from(
        { length: levels },
        (_unused, index) =>
          `level${index + 1}: &level${index + 1} [${Array(fanOut).fill(`*level${index}`).join(",")}]`,
      ),
      `expanded: *level${levels}`,
    ].join("\n");

  test("rejects nested aliases that expand far beyond their source size", async () => {
    const content = nestedAliasBomb(8, 5);
    expect(content.length).toBeLessThan(1_000);

    const error = await parseFailure(content);

    expect(error).toMatchObject({ _tag: "LandofileParseError" });
    expect(error.message).toMatch(/exceeded the maximum of \d+ expanded nodes/);
    expect(error.remediation).toMatch(/alias/i);
  });

  test("accepts a document whose node count is bounded by its own source", async () => {
    const services = Array.from(
      { length: 400 },
      (_unused, index) => `  service${index}:\n    <<: *defaults\n    port: ${index}`,
    );
    const content = ["defaults: &defaults", "  api: 4", "  type: nginx", "services:", ...services].join("\n");

    const parsed = (await parse(content)) as { services: Record<string, unknown> };

    expect(Object.keys(parsed.services)).toHaveLength(400);
    expect(parsed.services.service399).toEqual({ api: 4, type: "nginx", port: 399 });
  });

  test("rejects an acyclic alias chain deeper than the parser limit", async () => {
    const content = [
      "level0: &level0 leaf",
      ...Array.from(
        { length: 8 },
        (_unused, index) => `level${index + 1}: &level${index + 1} *level${index}`,
      ),
      "expanded: *level8",
    ].join("\n");

    const error = await parseFailure(content, { maxDepth: 4 });

    expect(error).toMatchObject({ _tag: "LandofileParseError" });
    expect(error.message).toMatch(/alias graph exceeded the maximum depth of 4/i);
    expect(error.remediation).toMatch(/alias/i);
  });
});
