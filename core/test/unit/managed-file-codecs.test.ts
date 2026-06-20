import { describe, expect, test } from "bun:test";

import { Effect, Exit } from "effect";

import { ManagedFileError } from "@lando/sdk/errors";

import { decode, encode, mergeManaged } from "../../src/managed-file/codecs.ts";

const run = <A>(effect: Effect.Effect<A, ManagedFileError>): Promise<A> => Effect.runPromise(effect);

const runExit = <A>(effect: Effect.Effect<A, ManagedFileError>) => Effect.runPromiseExit(effect);

const failure = async <A>(effect: Effect.Effect<A, ManagedFileError>): Promise<ManagedFileError> => {
  const exit = await runExit(effect);
  if (Exit.isFailure(exit)) {
    const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
    if (error instanceof ManagedFileError) return error;
  }
  throw new Error("expected a ManagedFileError failure");
};

describe("managed-file codecs — encode", () => {
  test("text is written verbatim", async () => {
    expect(await run(encode("text", "hello\nworld\n"))).toBe("hello\nworld\n");
  });

  test("json pretty-prints with a trailing newline", async () => {
    expect(await run(encode("json", { a: 1, b: ["x"] }))).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
  });

  test("env emits KEY=value lines with a trailing newline", async () => {
    expect(await run(encode("env", { FOO: "bar", NUM: 42 }))).toBe("FOO=bar\nNUM=42\n");
  });

  test("env quotes values that carry whitespace or structural characters", async () => {
    expect(await run(encode("env", { MSG: "hello world", EMPTY: "" }))).toBe('MSG="hello world"\nEMPTY=""\n');
  });

  test.each(["MY-KEY", "my.key", "1KEY", "has space"])(
    "env rejects key %p that decode cannot round-trip",
    async (key) => {
      const error = await failure(encode("env", { [key]: "value" }));
      expect(error.reason).toBe("format");
      expect(error.remediation).toContain("POSIX environment-variable name");
    },
  );

  test("yaml delegates to the @lando/sdk/landofile serializer", async () => {
    expect(await run(encode("yaml", { name: "app", runtime: 4 }))).toBe("name: app\nruntime: 4\n");
  });

  test("landofile delegates to the @lando/sdk/landofile serializer", async () => {
    expect(await run(encode("landofile", { name: "app", services: { web: { type: "php:8.3" } } }))).toBe(
      "name: app\nservices:\n  web:\n    type: php:8.3\n",
    );
  });

  test("toml is declared but deferred to 4.x", async () => {
    const error = await failure(encode("toml", { a: 1 }));
    expect(error.reason).toBe("format");
    expect(error.remediation).toContain("4.x");
  });

  test("ini is declared but deferred to 4.x", async () => {
    const error = await failure(encode("ini", { a: 1 }));
    expect(error.reason).toBe("format");
    expect(error.remediation).toContain("4.x");
  });

  test("a non-emittable structured value fails with reason format", async () => {
    const error = await failure(encode("yaml", { bad: Number.POSITIVE_INFINITY }));
    expect(error.reason).toBe("format");
  });

  test("non-string text content fails with reason format", async () => {
    const error = await failure(encode("text", { not: "a string" }));
    expect(error.reason).toBe("format");
  });

  test("encode carries the caller's operation onto the error", async () => {
    const error = await failure(encode("toml", { a: 1 }, { operation: "apply" }));
    expect(error.operation).toBe("apply");
  });
});

describe("managed-file codecs — decode", () => {
  test("text is returned verbatim", async () => {
    expect(await run(decode("text", "raw bytes\n"))).toBe("raw bytes\n");
  });

  test("json round-trips through encode", async () => {
    const value = { a: 1, nested: { b: [1, 2, 3] } };
    const text = await run(encode("json", value));
    expect(await run(decode("json", text))).toEqual(value);
  });

  test("env decodes KEY=value lines, ignoring comments and blanks", async () => {
    const text = '# comment\nFOO=bar\n\nMSG="hello world"\n';
    expect(await run(decode("env", text))).toEqual({ FOO: "bar", MSG: "hello world" });
  });

  test("env round-trips string values through encode", async () => {
    const value = { FOO: "bar", MSG: "hello world", EMPTY: "" };
    const text = await run(encode("env", value));
    expect(await run(decode("env", text))).toEqual(value);
  });

  test("yaml/landofile decode delegates to parseLandofile and round-trips", async () => {
    const value = { name: "app", services: { db: { type: "mysql:8.0" } }, tags: ["a", "b"] };
    const text = await run(encode("landofile", value));
    expect(await run(decode("landofile", text))).toEqual(value);
    expect(await run(decode("yaml", text))).toEqual(value);
  });

  test("invalid json fails with reason decode", async () => {
    const error = await failure(decode("json", "{not valid"));
    expect(error.reason).toBe("decode");
  });

  test("invalid landofile content fails with reason decode", async () => {
    const error = await failure(decode("landofile", "name: ${env.X}\n"));
    expect(error.reason).toBe("decode");
  });

  test("toml decode is deferred to 4.x", async () => {
    const error = await failure(decode("toml", "a = 1"));
    expect(error.reason).toBe("format");
    expect(error.remediation).toContain("4.x");
  });
});

describe("managed-file codecs — mergeManaged (keys-mode stub)", () => {
  test.each(["env", "json", "yaml", "landofile"] as const)(
    "%s keys-mode merge is deferred to 4.x",
    async (format) => {
      const error = await failure(mergeManaged(format, { a: 1 }, { b: 2 }, "# lando"));
      expect(error.reason).toBe("format");
      expect(error.remediation).toContain("4.x");
    },
  );

  test("text keys-mode merge is also deferred to 4.x", async () => {
    const error = await failure(mergeManaged("text", "existing", "owned", "# lando"));
    expect(error.reason).toBe("format");
    expect(error.remediation).toContain("4.x");
  });
});
