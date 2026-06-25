import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
  LandofileEmitError,
  emitLandofileYaml,
  emitLandofileYamlEither,
  parseLandofile,
} from "@lando/sdk/landofile";

const roundTrip = (value: Record<string, unknown>): Promise<unknown> =>
  Effect.runPromise(parseLandofile({ file: ".lando.yml", content: emitLandofileYaml(value), cwd: "/tmp" }));

describe("Landofile serializer hardening — key validation", () => {
  test("rejects a key with a space", () => {
    expect(() => emitLandofileYaml({ "web service": 1 })).toThrow(LandofileEmitError);
  });

  test("rejects a key with a colon", () => {
    expect(() => emitLandofileYaml({ "a:b": 1 })).toThrow(LandofileEmitError);
  });

  test("rejects a key with a slash", () => {
    expect(() => emitLandofileYaml({ "a/b": 1 })).toThrow(LandofileEmitError);
  });

  test("rejects a key with an @ (scoped package name)", () => {
    expect(() => emitLandofileYaml({ "@lando/foo": 1 })).toThrow(LandofileEmitError);
  });

  test("rejects an empty-string key", () => {
    expect(() => emitLandofileYaml({ "": 1 })).toThrow(LandofileEmitError);
  });

  test("accepts conforming keys with dots, dashes, underscores, digits", () => {
    expect(() => emitLandofileYaml({ "php-7.4_x.y": 1, DB_HOST: "x", "0": "z" })).not.toThrow();
  });

  test("validates nested map keys too", () => {
    expect(() => emitLandofileYaml({ services: { "bad key": { type: "php" } } })).toThrow(LandofileEmitError);
  });

  test("validates list-item map keys too", () => {
    expect(() => emitLandofileYaml({ includes: [{ "bad key": "x" }] })).toThrow(LandofileEmitError);
  });

  test("the emit error message carries the offending key path", () => {
    try {
      emitLandofileYaml({ services: { web: { "bad key": 1 } } });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LandofileEmitError);
      expect((error as LandofileEmitError).message).toContain("bad key");
    }
  });
});

describe("Landofile serializer hardening — non-emittable values", () => {
  test("rejects a Date instead of silently emitting an empty map", () => {
    expect(() => emitLandofileYaml({ d: new Date(0) })).toThrow(LandofileEmitError);
  });

  test("rejects a class instance instead of silently emitting a map", () => {
    class Foo {
      x = 1;
    }
    expect(() => emitLandofileYaml({ c: new Foo() })).toThrow(LandofileEmitError);
  });

  test("rejects a RegExp", () => {
    expect(() => emitLandofileYaml({ r: /x/u })).toThrow(LandofileEmitError);
  });

  test("rejects a Map", () => {
    expect(() => emitLandofileYaml({ m: new Map() })).toThrow(LandofileEmitError);
  });

  test("rejects undefined", () => {
    expect(() => emitLandofileYaml({ u: undefined })).toThrow(LandofileEmitError);
  });

  test("rejects a non-finite number", () => {
    expect(() => emitLandofileYaml({ n: Number.POSITIVE_INFINITY })).toThrow(LandofileEmitError);
    expect(() => emitLandofileYaml({ n: Number.NaN })).toThrow(LandofileEmitError);
  });

  test("rejects a bigint", () => {
    expect(() => emitLandofileYaml({ b: 10n })).toThrow(LandofileEmitError);
  });

  test("rejects a symbol value", () => {
    expect(() => emitLandofileYaml({ s: Symbol("x") as unknown as string })).toThrow(LandofileEmitError);
  });

  test("rejects a function value", () => {
    expect(() => emitLandofileYaml({ f: (() => 1) as unknown as string })).toThrow(LandofileEmitError);
  });

  test("rejects a nested array", () => {
    expect(() => emitLandofileYaml({ a: [[1, 2]] as unknown as ReadonlyArray<unknown> })).toThrow(
      LandofileEmitError,
    );
  });

  test("rejects a symbol-keyed object", () => {
    const obj: Record<string | symbol, unknown> = { ok: 1 };
    obj[Symbol("hidden")] = 2;
    expect(() => emitLandofileYaml(obj)).toThrow(LandofileEmitError);
  });

  test("rejects a nested object with only symbol keys instead of emitting an empty map", () => {
    const nested: Record<string | symbol, unknown> = {};
    nested[Symbol("hidden")] = 2;
    expect(() => emitLandofileYaml({ parent: nested })).toThrow(LandofileEmitError);
  });

  test("rejects a list-item object with only symbol keys instead of emitting an empty map", () => {
    const item: Record<string | symbol, unknown> = {};
    item[Symbol("hidden")] = 2;
    expect(() => emitLandofileYaml({ list: [item] })).toThrow(LandofileEmitError);
  });

  test("rejects a cyclic object without hanging", () => {
    const cyclic: Record<string, unknown> = { name: "app" };
    cyclic.self = cyclic;
    expect(() => emitLandofileYaml(cyclic)).toThrow(LandofileEmitError);
  });

  test("the Either form returns Left for a non-emittable input", () => {
    const result = emitLandofileYamlEither({ d: new Date(0) });
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(LandofileEmitError);
    }
  });
});

describe("Landofile serializer hardening — quoted ${…} round-trips as a literal", () => {
  test("a quoted ${secret:DB_PASSWORD} round-trips unchanged", async () => {
    const value = { tooling: { migrate: { cmd: "${secret:DB_PASSWORD}" } } };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("a ${secret:…} inside an array round-trips", async () => {
    const value = { args: ["${secret:TOKEN}", "literal"] };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("a ${secret:…} as a top-level scalar round-trips", async () => {
    const value = { password: "${secret:DB_PASSWORD}" };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("an UNQUOTED ${VAR} in raw YAML is still rejected as an expression", () => {
    const program = parseLandofile({ file: ".lando.yml", content: "x: ${VAR}\n", cwd: "/tmp" });
    expect(Effect.runPromise(program)).rejects.toThrow();
  });
});

describe("Landofile serializer hardening — sortKeys option", () => {
  test("default preserves insertion order (no behavior change)", () => {
    const yaml = emitLandofileYaml({ b: 1, a: 2, c: 3 });
    expect(yaml).toBe("b: 1\na: 2\nc: 3\n");
  });

  test("sortKeys:false is identical to the default", () => {
    expect(emitLandofileYaml({ b: 1, a: 2 }, { sortKeys: false })).toBe(emitLandofileYaml({ b: 1, a: 2 }));
  });

  test("sortKeys:true sorts top-level keys", () => {
    const yaml = emitLandofileYaml({ b: 1, a: 2, c: 3 }, { sortKeys: true });
    expect(yaml).toBe("a: 2\nb: 1\nc: 3\n");
  });

  test("sortKeys:true sorts nested map keys recursively", () => {
    const yaml = emitLandofileYaml({ svc: { z: 1, a: 2 }, name: "app" }, { sortKeys: true });
    expect(yaml).toBe("name: app\nsvc:\n  a: 2\n  z: 1\n");
  });

  test("sortKeys:true does not reorder array elements", async () => {
    const value = { tags: ["c", "a", "b"] };
    const yaml = emitLandofileYaml(value, { sortKeys: true });
    const parsed = await Effect.runPromise(
      parseLandofile({ file: ".lando.yml", content: yaml, cwd: "/tmp" }),
    );
    expect(parsed).toEqual(value);
  });

  test("sortKeys:true output still round-trips", async () => {
    const value = { name: "app", services: { web: { type: "php" }, db: { type: "mysql" } } };
    const yaml = emitLandofileYaml(value, { sortKeys: true });
    const parsed = await Effect.runPromise(
      parseLandofile({ file: ".lando.yml", content: yaml, cwd: "/tmp" }),
    );
    expect(parsed).toEqual(value);
  });

  test("emitLandofileYamlEither accepts the sortKeys option", () => {
    const result = emitLandofileYamlEither({ b: 1, a: 2 }, { sortKeys: true });
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right).toBe("a: 2\nb: 1\n");
    }
  });
});

describe("Landofile serializer hardening — list-item map keys with dots/digits round-trip", () => {
  test("a list-item map key with a leading digit and dot round-trips", async () => {
    const value = { includes: [{ "1.key": "x", other: "y" }] };
    expect(await roundTrip(value)).toEqual(value);
  });
});
