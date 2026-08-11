import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { ManagedFileError } from "@lando/sdk/errors";

import { decode, encode } from "../src/codecs.ts";

const run = <A>(effect: Effect.Effect<A, ManagedFileError>): Promise<A> => Effect.runPromise(effect);

const failure = async <A>(effect: Effect.Effect<A, ManagedFileError>): Promise<ManagedFileError> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof ManagedFileError) {
    return exit.cause.error;
  }
  throw new Error("expected a ManagedFileError failure");
};

describe("managed-file codecs", () => {
  test("encodes every declared format with current deferred errors", async () => {
    // Given
    const verbatim = "export const value = 1;\n";

    // When / Then
    expect(await run(encode("text", verbatim))).toBe(verbatim);
    expect(await run(encode("javascript", verbatim))).toBe(verbatim);
    expect(await run(encode("typescript", verbatim))).toBe(verbatim);
    expect(await run(encode("json", { value: 1 }))).toBe('{\n  "value": 1\n}\n');
    expect(await run(encode("env", { VALUE: "one" }))).toBe("VALUE=one\n");
    expect(await run(encode("yaml", { name: "app", runtime: 4 }))).toBe("name: app\nruntime: 4\n");
    expect(await run(encode("landofile", { name: "app", services: { web: { type: "php:8.3" } } }))).toBe(
      "name: app\nservices:\n  web:\n    type: php:8.3\n",
    );
    for (const format of ["toml", "ini"] as const) {
      const error = await failure(encode(format, { value: 1 }));
      expect(error.reason).toBe("format");
      expect(error.remediation).toContain("4.x");
    }
  });

  test("round-trips structured codecs including env escapes and landofile YAML", async () => {
    // Given
    const json = { nested: { enabled: true }, values: [1, 2] };
    const env = { MESSAGE: 'hello "world"', PATH_VALUE: "one\\two", MULTILINE: "one\ntwo" };
    const landofile = { name: "app", services: { db: { type: "mysql:8.0" } }, tags: ["a", "b"] };

    // When
    const jsonText = await run(encode("json", json));
    const envText = await run(encode("env", env));
    const landofileText = await run(encode("landofile", landofile));

    // Then
    expect(await run(decode("json", jsonText))).toEqual(json);
    expect(await run(decode("env", envText))).toEqual(env);
    expect(await run(decode("landofile", landofileText))).toEqual(landofile);
    expect(landofileText).toContain("services:\n  db:\n    type: mysql:8.0");
  });

  test("tags malformed and deferred decode failures with the current operation", async () => {
    // Given / When
    const jsonError = await failure(decode("json", "{not-json", { operation: "status" }));
    const landofileError = await failure(
      decode("landofile", "name: ${env.MISSING}\n", { operation: "status" }),
    );
    const tomlError = await failure(decode("toml", "value = 1", { operation: "status" }));

    // Then
    expect(jsonError.reason).toBe("decode");
    expect(jsonError.operation).toBe("status");
    expect(landofileError.reason).toBe("decode");
    expect(landofileError.operation).toBe("status");
    expect(tomlError.reason).toBe("format");
    expect(tomlError.operation).toBe("status");
  });
});
