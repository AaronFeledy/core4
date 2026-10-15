import { describe, expect, test } from "bun:test";
import { emitLandofileYaml, mergeLandofiles, mergeValues, parseLandofile } from "@lando/sdk/landofile";
import { Effect, Schema } from "effect";

const brand = Symbol.for("@lando/sdk/landofile/merge-directive");
const override = (value: unknown) => ({ [brand]: "override", value });
const reset = () => ({ [brand]: "reset" });
const parse = (content: string) =>
  Effect.runSync(parseLandofile({ file: ".lando.yml", cwd: "/tmp", content }));

describe("native merge directives", () => {
  test("replaces an inherited map when override is authored", () => {
    // Given a complete replacement, not a deep merge.
    const layers = [
      { services: { web: { environment: { OLD: "old" } } } },
      { services: { web: { environment: override({ NEW: "new" }) } } },
    ];
    // When the layers fold.
    const result = mergeLandofiles(layers);
    // Then inherited keys are absent.
    expect(result).toEqual({ services: { web: { environment: { NEW: "new" } } } });
  });

  test("removes existing and absent members without pruning their map", () => {
    // Given reset directives on existing and absent keys.
    const layers = [{ "x-data": { OLD: "old" } }, { "x-data": { OLD: reset(), ABSENT: reset() } }];
    // When the layers fold.
    const result = mergeLandofiles(layers);
    // Then reset means absence, not an empty wrapper.
    expect(result).toEqual({ "x-data": {} });
  });

  test("materializes directives in a new subtree and the public left input", () => {
    // Given directives in both inputs and inside a replacement list.
    const left = { old: reset(), keep: override("yes") };
    const right = { list: [{ gone: reset(), value: override(1) }] };
    // When opaque values merge.
    const result = mergeValues(Schema.Unknown, left, right);
    // Then no symbol-bearing directives escape.
    expect(result).toEqual({ keep: "yes", list: [{ value: 1 }] });
  });

  test.each(["!reset", "!reset null", "!reset ignored", "!reset []", "!reset {}"])(
    "normalizes ignored reset payload %s",
    (tag) => {
      // Given a reset spelling.
      const source = `environment:\n  FOO: ${tag}\n`;
      // When parsed.
      const result = parse(source);
      // Then reset carries no payload.
      expect(result).toEqual({ environment: { FOO: reset() } });
    },
  );

  test("parses tagged scalars, maps, lists, and first sequence-map members", () => {
    // Given all native tagged value forms.
    const source =
      "image: !override nginx:stable\nenvironment: !override\n  FOO: bar\nroutes: !override\n  - filters: !override []\n    hostname: web.test\n";
    // When parsed.
    const result = parse(source);
    // Then the authoring tree retains operations.
    expect(result).toEqual({
      image: override("nginx:stable"),
      environment: override({ FOO: "bar" }),
      routes: override([{ filters: override([]), hostname: "web.test" }]),
    });
  });

  test("preserves native directives through YAML emission", () => {
    // Given nested operations including a first sequence-map member.
    const value = {
      services: {
        web: {
          environment: override({ FOO: reset() }),
          routes: override([{ filters: override([]), hostname: "web.test" }]),
        },
      },
    };
    // When emitted and parsed.
    const result = parse(emitLandofileYaml(value));
    // Then kind and payload round-trip.
    expect(result).toEqual(value);
  });

  test.each(["name: !unknown value", "name: !override", "name: !reset [one]", "name: !override !reset"])(
    "rejects invalid directive syntax %s",
    (source) => {
      // Given malformed or unsupported tags.
      // When parsing, then fail with a typed parse error.
      expect(() => parse(source)).toThrow();
    },
  );
});
