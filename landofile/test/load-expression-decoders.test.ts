import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { LandofileExpressionEvalError, LandofileParseError } from "@lando/sdk/errors";

import { makeLandofileLoadHelperOverrides } from "../src/load-expression-decoders.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY, LandofileFileSession } from "../src/load-expression-file.ts";
import { resolveLandofileLoadExpressions } from "../src/load-expression.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

const YAML_1_2_STRING_WORDS = ["yes", "no", "on", "off", "y", "Y"] as const;

const POLICY = DEFAULT_LANDOFILE_LOAD_POLICY;

const withApp = async <A>(run: (appRoot: string) => Promise<A>): Promise<A> => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-decoder-"));
  try {
    return await run(appRoot);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
};

const sessionFor = (appRoot: string): LandofileFileSession =>
  new LandofileFileSession(
    {
      appRoot,
      sourcePath: join(appRoot, ".lando.yml"),
      sourceRoot: appRoot,
      layer: "canonical",
    },
    POLICY,
  );

const stageFixture = async (appRoot: string, name: string): Promise<string> => {
  const dest = join(appRoot, name);
  await copyFile(join(FIXTURES, name), dest);
  return dest;
};

const resolveValue = (appRoot: string, value: unknown) =>
  resolveLandofileLoadExpressions({
    value,
    source: {
      appRoot,
      sourcePath: join(appRoot, ".lando.yml"),
      sourceRoot: appRoot,
      layer: "canonical",
    },
    policy: POLICY,
  });

const yaml12Flags = {
  yes: "yes",
  no: "no",
  on: "on",
  off: "off",
  y: "y",
  Y: "Y",
  true: true,
  false: false,
} as const;

const composeOnYes = {
  services: {
    web: {
      image: "nginx",
      restart: "on",
      tty: "yes",
      stdin_open: "no",
      privileged: "off",
      labels: { y: "keep-as-string", Y: "also-a-string" },
    },
  },
  on: { condition: "service_started" },
  yes: { enabled: true },
} as const;

describe("YAML 1.2 boolean words", () => {
  test.each(["yaml", "fromYaml"] as const)("%s keeps YAML 1.2 boolean words as strings", async (decoder) => {
    await withApp(async (appRoot) => {
      // Given
      await stageFixture(appRoot, "yaml-1.2-bool-words.yml");
      const session = sessionFor(appRoot);
      const helpers = makeLandofileLoadHelperOverrides(session);
      const helper = helpers[decoder];
      if (helper === undefined) throw new Error(`expected ${decoder} helper`);

      // When
      const parsed = helper([session.load("./yaml-1.2-bool-words.yml")], {});

      // Then
      expect(parsed).toEqual({ flags: yaml12Flags });
      const flags = (parsed as { flags: Record<string, unknown> }).flags;
      for (const word of YAML_1_2_STRING_WORDS) {
        expect(typeof flags[word]).toBe("string");
        expect(flags[word]).toBe(word);
      }
      expect(flags.true).toBe(true);
      expect(flags.false).toBe(false);
    });
  });

  test("load() and import() round-trip Compose-ish on:/yes: keys and values as strings", async () => {
    await withApp(async (appRoot) => {
      // Given
      await stageFixture(appRoot, "compose-on-yes.yml");

      // When
      const loaded = await Effect.runPromise(
        resolveValue(appRoot, "{{ fromYaml(load('./compose-on-yes.yml')) }}"),
      );
      const imported = await Effect.runPromise(
        resolveValue(appRoot, {
          services: { web: { security: { ca: "{{ import('./compose-on-yes.yml') }}" } } },
        }),
      );

      // Then
      expect(loaded.value).toEqual(composeOnYes);
      expect(imported.value).toMatchObject({
        services: { web: { security: { ca: { _tag: "ImportRef", value: composeOnYes } } } },
      });
    });
  });
});

describe("TOML SyntaxError wrapping", () => {
  test("wraps duplicate-key SyntaxError in LandofileExpressionEvalError", async () => {
    await withApp(async (appRoot) => {
      // Given
      await stageFixture(appRoot, "toml-duplicate-keys.toml");
      const session = sessionFor(appRoot);
      const helpers = makeLandofileLoadHelperOverrides(session);
      const fromToml = helpers.fromToml;
      if (fromToml === undefined) throw new Error("expected fromToml helper");
      const ref = session.load("./toml-duplicate-keys.toml");

      // When
      let caught: unknown;
      try {
        fromToml([ref], {});
      } catch (cause) {
        caught = cause;
      }

      // Then
      expect(caught).toBeInstanceOf(LandofileExpressionEvalError);
      if (!(caught instanceof LandofileExpressionEvalError)) throw new Error("expected eval error");
      expect(caught.message).toContain("fromToml");
      expect(caught.message).toContain("Cannot redefine key");
      expect(caught.cause).toBeInstanceOf(SyntaxError);
      expect(caught.cause).not.toBeInstanceOf(LandofileExpressionEvalError);
    });
  });

  test("wraps integers outside MAX_SAFE_INTEGER in LandofileExpressionEvalError", async () => {
    await withApp(async (appRoot) => {
      // Given
      await stageFixture(appRoot, "toml-unsafe-integer.toml");
      const session = sessionFor(appRoot);
      const helpers = makeLandofileLoadHelperOverrides(session);
      const fromToml = helpers.fromToml;
      if (fromToml === undefined) throw new Error("expected fromToml helper");

      // When
      let caught: unknown;
      try {
        fromToml([session.load("./toml-unsafe-integer.toml")], {});
      } catch (cause) {
        caught = cause;
      }

      // Then
      expect(caught).toBeInstanceOf(LandofileExpressionEvalError);
      if (!(caught instanceof LandofileExpressionEvalError)) throw new Error("expected eval error");
      expect(caught.message).toContain("fromToml");
      expect(caught.message).toContain("2^53");
      expect(caught.cause).toBeInstanceOf(SyntaxError);
    });
  });

  test("load() surfaces wrapped TOML SyntaxError as LandofileParseError", async () => {
    await withApp(async (appRoot) => {
      // Given
      await stageFixture(appRoot, "toml-duplicate-keys.toml");

      // When
      const exit = await Effect.runPromiseExit(
        resolveValue(appRoot, "{{ fromToml(load('./toml-duplicate-keys.toml')) }}"),
      );

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("expected decode failure");
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag !== "Some") throw new Error("expected tagged failure");
      expect(failure.value).toBeInstanceOf(LandofileParseError);
      expect(failure.value.message).toContain("Cannot redefine key");
      expect(failure.value.cause).toBeInstanceOf(LandofileExpressionEvalError);
    });
  });
});

describe("TOML Temporal date/time literals", () => {
  test("Bun.TOML.parse currently returns Temporal objects for date/time literals", async () => {
    // Given
    const source = await Bun.file(join(FIXTURES, "toml-dates.toml")).text();

    // When
    const parsed = Bun.TOML.parse(source) as Record<string, unknown>;

    // Then: lock Bun 1.4 parser output so a later decoder change is explicit.
    expect(Object.prototype.toString.call(parsed.offset)).toBe("[object Temporal.Instant]");
    expect(Object.prototype.toString.call(parsed.offset_west)).toBe("[object Temporal.Instant]");
    expect(Object.prototype.toString.call(parsed.local_datetime)).toBe("[object Temporal.PlainDateTime]");
    expect(Object.prototype.toString.call(parsed.local_date)).toBe("[object Temporal.PlainDate]");
    expect(Object.prototype.toString.call(parsed.local_time)).toBe("[object Temporal.PlainTime]");
    const nested = parsed.nested as { stamp: unknown };
    expect(Object.prototype.toString.call(nested.stamp)).toBe("[object Temporal.Instant]");
  });

  test("fromToml converts Temporal date/time literals to ISO strings", async () => {
    await withApp(async (appRoot) => {
      // Given
      await stageFixture(appRoot, "toml-dates.toml");
      const session = sessionFor(appRoot);
      const helpers = makeLandofileLoadHelperOverrides(session);
      const fromToml = helpers.fromToml;
      if (fromToml === undefined) throw new Error("expected fromToml helper");

      // When
      const parsed = fromToml([session.load("./toml-dates.toml")], {});

      // Then
      expect(parsed).toEqual({
        offset: "1979-05-27T07:32:00Z",
        offset_west: "1979-05-27T07:32:00Z",
        local_datetime: "1979-05-27T07:32:00",
        local_date: "1979-05-27",
        local_time: "07:32:00",
        nested: { stamp: "1979-05-27T07:32:00Z" },
      });
    });
  });
});

describe("JSON5 / JSONC / JSONL decoders", () => {
  test.each(["json5", "fromJson5"] as const)(
    "%s parses JSON5 comments and unquoted keys",
    async (decoder) => {
      await withApp(async (appRoot) => {
        await stageFixture(appRoot, "sample.json5");
        const session = sessionFor(appRoot);
        const helpers = makeLandofileLoadHelperOverrides(session);
        const helper = helpers[decoder];
        if (helper === undefined) throw new Error(`expected ${decoder} helper`);

        const parsed = helper([session.load("./sample.json5")], {});

        expect(parsed).toEqual({ unquoted: "yes", trailing: 1 });
      });
    },
  );

  test.each(["json5", "fromJson5"] as const)(
    "%s wraps syntax errors as LandofileExpressionEvalError",
    async (decoder) => {
      await withApp(async (appRoot) => {
        await stageFixture(appRoot, "bad.json5");
        const session = sessionFor(appRoot);
        const helpers = makeLandofileLoadHelperOverrides(session);
        const helper = helpers[decoder];
        if (helper === undefined) throw new Error(`expected ${decoder} helper`);

        let caught: unknown;
        try {
          helper([session.load("./bad.json5")], {});
        } catch (cause) {
          caught = cause;
        }

        expect(caught).toBeInstanceOf(LandofileExpressionEvalError);
        if (!(caught instanceof LandofileExpressionEvalError)) throw new Error("expected eval error");
        expect(caught.message).toContain(decoder);
        expect(caught.cause).toBeInstanceOf(SyntaxError);
      });
    },
  );

  test.each(["jsonc", "fromJsonc"] as const)(
    "%s parses JSONC comments and trailing commas",
    async (decoder) => {
      await withApp(async (appRoot) => {
        await stageFixture(appRoot, "sample.jsonc");
        const session = sessionFor(appRoot);
        const helpers = makeLandofileLoadHelperOverrides(session);
        const helper = helpers[decoder];
        if (helper === undefined) throw new Error(`expected ${decoder} helper`);

        expect(helper([session.load("./sample.jsonc")], {})).toEqual({ quoted: "yes", trailing: 1 });
      });
    },
  );

  test.each(["jsonc", "fromJsonc"] as const)(
    "%s rejects JSON5 unquoted keys so sample.json5 is not faked as JSON5",
    async (decoder) => {
      await withApp(async (appRoot) => {
        await stageFixture(appRoot, "sample.json5");
        const session = sessionFor(appRoot);
        const helpers = makeLandofileLoadHelperOverrides(session);
        const helper = helpers[decoder];
        if (helper === undefined) throw new Error(`expected ${decoder} helper`);

        let caught: unknown;
        try {
          helper([session.load("./sample.json5")], {});
        } catch (cause) {
          caught = cause;
        }

        expect(caught).toBeInstanceOf(LandofileExpressionEvalError);
        if (!(caught instanceof LandofileExpressionEvalError)) throw new Error("expected eval error");
        expect(caught.message).toContain(decoder);
      });
    },
  );

  test.each(["jsonc", "fromJsonc"] as const)(
    "%s wraps syntax errors as LandofileExpressionEvalError",
    async (decoder) => {
      await withApp(async (appRoot) => {
        await stageFixture(appRoot, "bad.jsonc");
        const session = sessionFor(appRoot);
        const helpers = makeLandofileLoadHelperOverrides(session);
        const helper = helpers[decoder];
        if (helper === undefined) throw new Error(`expected ${decoder} helper`);

        let caught: unknown;
        try {
          helper([session.load("./bad.jsonc")], {});
        } catch (cause) {
          caught = cause;
        }

        expect(caught).toBeInstanceOf(LandofileExpressionEvalError);
        if (!(caught instanceof LandofileExpressionEvalError)) throw new Error("expected eval error");
        expect(caught.message).toContain(decoder);
      });
    },
  );

  test.each(["jsonl", "fromJsonl"] as const)("%s parses lines and skips blanks", async (decoder) => {
    await withApp(async (appRoot) => {
      await stageFixture(appRoot, "sample.jsonl");
      const session = sessionFor(appRoot);
      const helpers = makeLandofileLoadHelperOverrides(session);
      const helper = helpers[decoder];
      if (helper === undefined) throw new Error(`expected ${decoder} helper`);

      expect(helper([session.load("./sample.jsonl")], {})).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    });
  });

  test.each(["jsonl", "fromJsonl"] as const)(
    "%s tags a bad line with LandofileExpressionEvalError and the line number",
    async (decoder) => {
      await withApp(async (appRoot) => {
        await stageFixture(appRoot, "bad.jsonl");
        const session = sessionFor(appRoot);
        const helpers = makeLandofileLoadHelperOverrides(session);
        const helper = helpers[decoder];
        if (helper === undefined) throw new Error(`expected ${decoder} helper`);

        let caught: unknown;
        try {
          helper([session.load("./bad.jsonl")], {});
        } catch (cause) {
          caught = cause;
        }

        expect(caught).toBeInstanceOf(LandofileExpressionEvalError);
        if (!(caught instanceof LandofileExpressionEvalError)) throw new Error("expected eval error");
        expect(caught.message).toContain(decoder);
        expect(caught.message).toContain("line 2");
      });
    },
  );

  test("import() infers json5, jsonc, jsonl, and ndjson decoders", async () => {
    await withApp(async (appRoot) => {
      await stageFixture(appRoot, "sample.json5");
      await stageFixture(appRoot, "sample.jsonc");
      await stageFixture(appRoot, "sample.jsonl");
      await stageFixture(appRoot, "sample.ndjson");

      const imported = async (name: string) =>
        Effect.runPromise(
          resolveValue(appRoot, {
            services: { web: { security: { ca: `{{ import('./${name}') }}` } } },
          }),
        );

      const json5 = await imported("sample.json5");
      const jsonc = await imported("sample.jsonc");
      const jsonl = await imported("sample.jsonl");
      const ndjson = await imported("sample.ndjson");

      expect(json5.value).toMatchObject({
        services: {
          web: { security: { ca: { _tag: "ImportRef", value: { unquoted: "yes", trailing: 1 } } } },
        },
      });
      expect(jsonc.value).toMatchObject({
        services: { web: { security: { ca: { _tag: "ImportRef", value: { quoted: "yes", trailing: 1 } } } } },
      });
      expect(jsonl.value).toMatchObject({
        services: { web: { security: { ca: { _tag: "ImportRef", value: [{ a: 1 }, { b: 2 }, { c: 3 }] } } } },
      });
      expect(ndjson.value).toMatchObject({
        services: {
          web: { security: { ca: { _tag: "ImportRef", value: [{ name: "one" }, { name: "two" }] } } },
        },
      });
    });
  });

  test("unknown decoder remediation lists the additive JSON helpers", async () => {
    await withApp(async (appRoot) => {
      await stageFixture(appRoot, "sample.json5");
      const session = sessionFor(appRoot);
      const helpers = makeLandofileLoadHelperOverrides(session);
      const load = helpers.load;
      if (load === undefined) throw new Error("expected load helper");

      let caught: unknown;
      try {
        load(["./sample.json5", "not-a-decoder"], {});
      } catch (cause) {
        caught = cause;
      }

      expect(caught).toBeInstanceOf(LandofileExpressionEvalError);
      if (!(caught instanceof LandofileExpressionEvalError)) throw new Error("expected eval error");
      expect(caught.remediation).toContain("json5");
      expect(caught.remediation).toContain("jsonc");
      expect(caught.remediation).toContain("jsonl");
    });
  });
});
