import { describe, expect, test } from "bun:test";
import type { ToolingTaskShape } from "@lando/sdk/schema";
import { Either } from "effect";
import { parseToolingArgv, resolveServiceRef } from "../src/tooling-input.ts";
import { type ToolingServiceRef, normalizeToolingTask } from "../src/tooling-normalize.ts";

const normalize = (task: ToolingTaskShape) =>
  Either.getOrThrow(normalizeToolingTask("run", task, { path: "/app/.lando.yml" }));

describe("parseToolingArgv", () => {
  test("passes through undeclared input unchanged", () => {
    // Given
    const argv = ["--unknown", "value", "--", "-x"];
    // When
    const result = Either.getOrThrow(parseToolingArgv(normalize({ arguments: false }), argv));
    // Then
    expect(result).toEqual({ flags: {}, args: {}, argv });
  });

  test.each([{ argv: ["--name=x"] }, { argv: ["--name", "x"] }, { argv: ["-n", "x"] }, { argv: ["-n=x"] }])(
    "accepts value syntax %j",
    ({ argv }) => {
      // Given
      const task = normalize({ flags: { name: { alias: "n" }, loud: { boolean: true } } });
      // When
      const result = Either.getOrThrow(parseToolingArgv(task, [...argv, "--loud"]));
      // Then
      expect(result).toEqual({ flags: { name: "x", loud: true }, args: {}, argv: ["--name=x", "--loud"] });
    },
  );

  const invalid: readonly (readonly [string, ToolingTaskShape, readonly string[], string | undefined])[] = [
    ["unknown flag", { flags: { name: {} } }, ["--other"], "other"],
    ["boolean value", { flags: { loud: { boolean: true } } }, ["--loud=1"], "loud"],
    ["missing value", { flags: { name: {} } }, ["--name"], "name"],
    ["flag instead of value", { flags: { name: {}, loud: { boolean: true } } }, ["--name", "--loud"], "name"],
    ["missing required flag", { flags: { name: { required: true } } }, [], "name"],
    ["missing required arg", { args: { file: { required: true } } }, [], "file"],
    ["flag choice", { flags: { name: { choices: ["x"] } } }, ["--name=y"], "name"],
    ["arg choice", { args: { file: { choices: ["x"] } } }, ["y"], "file"],
    ["extra positional", { args: { file: {} } }, ["x", "y"], undefined],
    ["prototype flag", { flags: { name: {} } }, ["--toString=x"], "toString"],
  ];
  test.each(invalid)("rejects %s", (_label, authored, argv, field) => {
    // Given
    const task = normalize(authored);
    // When
    const result = parseToolingArgv(task, argv);
    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({ _tag: "ToolingInputError", tool: "run", source: task.source });
      if (field !== undefined) expect(result.left.field).toBe(field);
      expect(result.left.remediation).toBeTruthy();
    }
  });

  test("fills defaults in canonical declaration and resolved positional order", () => {
    // Given
    const task = normalize({
      flags: {
        first: { default: 2 },
        quiet: { boolean: true, default: false },
        loud: { boolean: true, default: true },
        last: {},
      },
      args: { second: { order: 1, default: "b" }, first: { order: 0, default: "a" } },
    });
    // When
    const result = Either.getOrThrow(parseToolingArgv(task, ["--last=z"]));
    // Then
    expect(result).toEqual({
      flags: { first: "2", quiet: false, loud: true, last: "z" },
      args: { first: "a", second: "b" },
      argv: ["--first=2", "--loud", "--last=z", "a", "b"],
    });
  });

  test("canonicalizes supplied flags regardless of caller ordering", () => {
    // Given
    const task = normalize({ flags: { first: {}, last: {} }, args: { file: {} } });
    // When
    const result = Either.getOrThrow(parseToolingArgv(task, ["--last=z", "file", "--first=a"]));
    // Then
    expect(result.argv).toEqual(["--first=a", "--last=z", "file"]);
  });

  test("treats tokens after terminator as positional", () => {
    // Given
    const task = normalize({ args: { file: {} } });
    // When
    const result = Either.getOrThrow(parseToolingArgv(task, ["--", "--file"]));
    // Then
    expect(result.args).toEqual({ file: "--file" });
  });
});

describe("resolveServiceRef", () => {
  test.each([
    [undefined, undefined],
    [{ kind: "host" }, ":host"],
    [{ kind: "service", name: "appserver" }, "appserver"],
    [{ kind: "flag", flag: "target" }, "web"],
  ] satisfies readonly (readonly [ToolingServiceRef | undefined, string | undefined])[])(
    "resolves %j",
    (ref, expected) => {
      // Given
      const values = Either.getOrThrow(
        parseToolingArgv(normalize({ flags: { target: {} } }), ["--target=web"]),
      );
      // When
      const result = resolveServiceRef(ref, values);
      // Then
      expect(Either.getOrThrow(result)).toBe(expected);
    },
  );

  const invalidFlags: readonly Readonly<Record<string, string | boolean>>[] = [
    {},
    { target: "" },
    { target: true },
    { target: ":host" },
    { target: ":other" },
    { target: ":" },
  ];
  test.each([...invalidFlags])("rejects missing or invalid validated flag %j", (flags) => {
    // Given / When
    const result = resolveServiceRef(
      { kind: "flag", flag: "target" },
      { flags, args: {}, argv: ["--target=raw-is-not-trusted"] },
      { name: "deploy", source: { path: "/app/.lando.yml", task: "deploy" } },
    );
    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result))
      expect(result.left).toMatchObject({
        _tag: "ToolingInputError",
        tool: "deploy",
        field: "target",
        source: { path: "/app/.lando.yml", task: "deploy" },
      });
  });
});
