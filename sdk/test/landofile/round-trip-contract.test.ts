// Round-trip contract suite for the public `@lando/sdk/landofile` surface.
// Proves `parseLandofile(emitLandofileYaml(x))` deep-equals `x` across the supported
// domain, that the rejection set fails with `LandofileEmitError` without emitting,
// that a merged `LandofileShape` fragment re-decodes after emit, and that emitted
// output is deterministic. Imports the published subpath only — no relative core
// internals — so it doubles as the surface-stability gate for plugin authors.

import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import {
  LandofileEmitError,
  emitLandofileYaml,
  emitLandofileYamlEither,
  parseLandofile,
} from "@lando/sdk/landofile";
import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import { yamlRoundTripCorpus, yamlRoundTripRecord } from "@lando/sdk/test";

const roundTrip = async (value: Record<string, unknown>): Promise<unknown> => {
  const yaml = emitLandofileYaml(value);
  return Effect.runPromise(parseLandofile({ file: ".lando.yml", content: yaml, cwd: "/tmp" }));
};

describe("@lando/sdk/landofile — round-trip law over the supported domain", () => {
  test("scalars: string, number, boolean, null", async () => {
    const value = { name: "my-app", runtime: 4, enabled: true, disabled: false, nothing: null };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("quotes number-looking and reserved-word strings so they stay strings", async () => {
    const value = { version: "8.0", flag: "true", empty: "", nullish: "null" };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("quotes strings with structural characters and whitespace", async () => {
    const value = { greeting: "hello world", note: "a: b", hash: "trailing # hash", lead: "- dashy" };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("escapes newlines and quotes in double-quoted scalars", async () => {
    const value = { multi: "line1\nline2\ttab", quoted: 'say "hi"' };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("double-quoted scalars unescape the full JSON escape set", async () => {
    // YAML document carries JSON-style escapes that the emitter may emit via JSON.stringify.
    const content = 'a: "x\\u0001y\\bz\\f/\\/"';
    const parsed = await Effect.runPromise(parseLandofile({ file: ".lando.yml", content, cwd: "/tmp" }));
    expect(parsed).toEqual({ a: "x\u0001y\bz\f//" });
  });

  test("keys outside the plain YAML set round-trip through quoting", async () => {
    const value = {
      "web service": 1,
      "a:b": 2,
      "a/b": 3,
      "@lando/foo": 4,
      "": 5,
      "<<": 6,
      "0": 7,
      on: 8,
      'say "hi"': 9,
      "tab\tkey": 10,
    };
    expect(await roundTrip(value)).toEqual(value);
    expect(Bun.YAML.parse(emitLandofileYaml(value))).toEqual(value);
  });

  test("nested maps", async () => {
    const value = {
      name: "app",
      services: { web: { type: "php:8.3", webroot: "web" }, db: { type: "mysql:8.0" } },
    };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("service logs blocks round-trip without changing sibling fields", async () => {
    const value = {
      name: "app",
      services: {
        web: {
          type: "apache",
          environment: { FOO: "bar" },
          logs: [
            {
              id: "error",
              label: "custom error log",
              path: "/app/var/log/error.log",
              stream: "stderr",
            },
          ],
        },
      },
      tooling: { test: { service: "web", cmd: "echo ok" } },
    };

    const parsed = await roundTrip(value);
    expect(parsed).toEqual(value);
    const decoded = Schema.decodeUnknownSync(LandofileShape)(parsed, { onExcessProperty: "error" });
    const web = decoded.services?.[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing");
    expect(web.logs?.[0]?.strategy).toBe("follow");
    expect(decoded.tooling?.test?.cmd).toBe("echo ok");
  });

  test("scalar arrays", async () => {
    const value = { name: "app", tags: ["a", "b", "c"], ports: [80, 443] };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("arrays of maps", async () => {
    const value = {
      includes: [
        { source: "git@example.com", resolved: "abc", checksum: "deadbeef" },
        { source: "npm:pkg", resolved: "1.0.0", checksum: "cafef00d" },
      ],
    };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("empty map and empty array round-trip as {} and []", async () => {
    const value = { name: "app", services: {}, tags: [] };
    expect(await roundTrip(value)).toEqual(value);
  });

  test("a quoted ${secret:…} reference round-trips unchanged", async () => {
    const value = {
      password: "${secret:DB_PASSWORD}",
      tooling: { migrate: { cmd: "${secret:MIGRATE_TOKEN}" } },
      args: ["${secret:TOKEN}", "literal"],
    };
    expect(await roundTrip(value)).toEqual(value);
  });
});

describe("@lando/sdk/landofile — rejection set fails with LandofileEmitError and never emits", () => {
  const expectRejected = (value: Record<string, unknown>, label: string): void => {
    test(label, () => {
      expect(() => emitLandofileYaml(value)).toThrow(LandofileEmitError);
      const result = emitLandofileYamlEither(value);
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(LandofileEmitError);
      }
    });
  };

  expectRejected({ u: undefined }, "undefined value");
  expectRejected({ n: Number.POSITIVE_INFINITY }, "non-finite number: Infinity");
  expectRejected({ n: Number.NaN }, "non-finite number: NaN");
  expectRejected({ b: 10n }, "bigint value");
  expectRejected({ a: [[1, 2]] as unknown as ReadonlyArray<unknown> }, "nested array value");

  test("a rejected emit produces no YAML output (throwing form never returns a string)", () => {
    let emitted: string | undefined;
    try {
      emitted = emitLandofileYaml({ bad: undefined });
    } catch {
      emitted = undefined;
    }
    expect(emitted).toBeUndefined();
  });

  test("the emit error message carries the offending value path", () => {
    try {
      emitLandofileYaml({ services: { web: { bad: undefined } } });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LandofileEmitError);
      expect((error as LandofileEmitError).message).toContain("services.web.bad");
    }
  });
});

describe("@lando/sdk/landofile — merged fragment preview re-decodes after emit", () => {
  test("a merged LandofileShape fragment re-decodes through the published surface", async () => {
    const merged = {
      name: "translated-app",
      runtime: 4 as const,
      services: { db: { type: "mysql:8.0" }, cache: { type: "redis:7" } },
      tooling: { migrate: { service: "db", cmd: "echo migrate" } },
    };
    const yaml = emitLandofileYaml(merged);
    const parsed = await Effect.runPromise(
      parseLandofile({ file: ".lando.yml", content: yaml, cwd: "/tmp" }),
    );
    const decoded = Schema.decodeUnknownSync(LandofileShape)(parsed, { onExcessProperty: "error" });
    expect(decoded.name).toBe("translated-app");
    const db = decoded.services?.[ServiceName.make("db")];
    if (db === undefined) throw new Error("db service missing");
    expect(db.type).toBe("mysql:8.0");
    expect(decoded.tooling?.migrate?.cmd).toBe("echo migrate");
  });

  test("a translator fragment carrying a ${secret:…} reference re-decodes after emit", async () => {
    const fragment = {
      name: "secretful-app",
      runtime: 4 as const,
      services: { db: { type: "mysql:8.0" } },
      tooling: { migrate: { service: "db", cmd: "migrate --token=${secret:MIGRATE_TOKEN}" } },
    };
    const yaml = emitLandofileYaml(fragment);
    const parsed = await Effect.runPromise(
      parseLandofile({ file: ".lando.yml", content: yaml, cwd: "/tmp" }),
    );
    const decoded = Schema.decodeUnknownSync(LandofileShape)(parsed, { onExcessProperty: "error" });
    expect(decoded.tooling?.migrate?.cmd).toBe("migrate --token=${secret:MIGRATE_TOKEN}");
  });
});

describe("@lando/sdk/landofile — emitted output is deterministic for a fixed input", () => {
  test("emitting the same input twice yields byte-identical YAML", () => {
    const value = {
      name: "app",
      runtime: 4,
      services: { web: { type: "php:8.3", webroot: "web" }, db: { type: "mysql:8.0" } },
      tooling: { migrate: { service: "db", cmd: "echo migrate" } },
      tags: ["c", "a", "b"],
    };
    expect(emitLandofileYaml(value)).toBe(emitLandofileYaml(value));
  });

  test("the sortKeys form is deterministic across calls", () => {
    const value = { b: 1, a: 2, svc: { z: 1, a: 2 } };
    expect(emitLandofileYaml(value, { sortKeys: true })).toBe(emitLandofileYaml(value, { sortKeys: true }));
  });
});

test("emitted Landofile YAML round-trips through Bun.YAML.parse over the danger corpus", () => {
  // Given
  const model = { env: yamlRoundTripRecord(), list: [...yamlRoundTripCorpus] };
  // When / Then
  expect(Bun.YAML.parse(emitLandofileYaml(model))).toEqual(model);
});

test("ambiguous scalars are quoted while fixture-critical plain values stay plain", () => {
  // Given
  const model = {
    a: "True",
    b: "~",
    c: "1e5",
    d: "0x10",
    e: "+5",
    f: ".inf",
    g: "-",
    h: "foo:",
    i: "[redacted]",
    j: "8080:80",
    k: ":host",
    l: "./relative",
    m: "docker.io/library/nginx:1.27",
  };
  // When
  const text = emitLandofileYaml(model);
  // Then
  for (const line of [
    'a: "True"',
    'b: "~"',
    'c: "1e5"',
    'd: "0x10"',
    'e: "+5"',
    'f: ".inf"',
    'g: "-"',
    'h: "foo:"',
    'i: "[redacted]"',
    "j: 8080:80",
    "k: :host",
    "l: ./relative",
    "m: docker.io/library/nginx:1.27",
  ]) {
    expect(text).toContain(`${line}\n`);
  }
});

test("the Landofile subset parser still round-trips the same corpus, including control characters", async () => {
  // Given
  const model = { env: yamlRoundTripRecord(), list: [...yamlRoundTripCorpus] };
  // When
  const parsed = await roundTrip(model);
  // Then
  expect(parsed).toEqual(model);
});
