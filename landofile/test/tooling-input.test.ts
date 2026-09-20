import { describe, expect, test } from "bun:test";
import { ToolingTaskShape } from "@lando/sdk/schema";
import { Either, Schema } from "effect";
import { parseToolingArgv, resolveServiceRef, serializeToolingInput } from "../src/tooling-input.ts";
import { type ToolingServiceRef, normalizeToolingTask } from "../src/tooling-normalize.ts";

const normalize = (task: typeof ToolingTaskShape.Encoded) =>
  Either.getOrThrow(
    normalizeToolingTask("run", Schema.decodeUnknownSync(ToolingTaskShape)(task), {
      path: "/app/.lando.yml",
    }),
  );

describe("parseToolingArgv", () => {
  test("serializes normalized order with a delimiter for hyphen positionals", () => {
    // Given
    const task = normalize({ args: { second: { order: 2 }, first: { order: 1 } } });
    // When
    const argv = Either.getOrThrow(
      serializeToolingInput(task, { flags: {}, args: { second: "b", first: "--first" } }),
    );
    // Then
    expect(argv).toEqual(["--", "--first", "b"]);
    expect(Either.getOrThrow(parseToolingArgv(task, argv)).args).toEqual({ first: "--first", second: "b" });
  });

  test("preserves every raw argv byte when no inputs are declared", () => {
    // Given
    const task = normalize({ cmd: ["echo"] });
    const argv = ["", "--unknown=a=b", "two words", "\t\n", "é", "--", "-x", "'quoted'"];
    // When
    const serialized = Either.getOrThrow(
      serializeToolingInput(task, { flags: {}, args: {}, passthroughArgv: argv }),
    );
    const parsed = Either.getOrThrow(parseToolingArgv(task, serialized));
    // Then
    expect(parsed.argv.map((value) => new TextEncoder().encode(value))).toEqual(
      argv.map((value) => new TextEncoder().encode(value)),
    );
  });
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

const OMITTED_FIRST_MESSAGE =
  "Positional argument first cannot be omitted because a later positional argument has a value.";
const OMITTED_FIRST_REMEDIATION =
  "Supply argument first or change the tooling declaration so no later positional value follows it.";

const leftOf = <A, E>(result: Either.Either<A, E>): E | undefined =>
  Either.isLeft(result) ? result.left : undefined;

describe("positional slot identity", () => {
  test("refuses an omitted leading positional instead of shifting a later value into its slot", () => {
    // Given a declaration whose leading positional is optional
    const task = normalize({ args: { first: { order: 0 }, second: { order: 1 } } });
    // When only the later positional carries a value
    const result = serializeToolingInput(task, { flags: {}, args: { second: "b" } });
    // Then the serializer names the argument it cannot express instead of emitting ["--", "b"]
    expect(leftOf(result)).toMatchObject({
      _tag: "ToolingInputError",
      tool: "run",
      field: "first",
      message: OMITTED_FIRST_MESSAGE,
      remediation: OMITTED_FIRST_REMEDIATION,
      source: { path: "/app/.lando.yml", task: "run" },
    });
  });

  test("refuses an omitted leading positional rather than canonicalizing a later default into its slot", () => {
    // Given a later positional that resolves from its own default
    const task = normalize({ args: { first: { order: 0 }, second: { order: 1, default: "b" } } });
    // When the caller supplies no positionals at all
    const result = parseToolingArgv(task, []);
    // Then the parser refuses instead of emitting canonical ["b"], which rebinds to first
    expect(leftOf(result)).toMatchObject({
      _tag: "ToolingInputError",
      tool: "run",
      field: "first",
      message: OMITTED_FIRST_MESSAGE,
      remediation: OMITTED_FIRST_REMEDIATION,
      source: { path: "/app/.lando.yml", task: "run" },
    });
  });

  test("fills an omitted leading positional from its declared default", () => {
    // Given a leading positional that can resolve without the caller
    const task = normalize({ args: { first: { order: 0, default: "a" }, second: { order: 1 } } });
    // When only the later positional carries a value
    const argv = Either.getOrThrow(serializeToolingInput(task, { flags: {}, args: { second: "b" } }));
    // Then both names survive the round trip in their declared slots
    expect(argv).toEqual(["--", "a", "b"]);
    expect(Either.getOrThrow(parseToolingArgv(task, argv)).args).toEqual({ first: "a", second: "b" });
  });

  test("keeps serialized argv and named values stable across repeated round trips", () => {
    // Given a declaration mixing defaulted flags with a defaulted leading positional
    const task = normalize({
      flags: { loud: { boolean: true }, name: { default: "world" } },
      args: { first: { order: 0, default: "a" }, second: { order: 1 } },
    });
    const roundTrip = (values: {
      readonly flags: Readonly<Record<string, string | boolean>>;
      readonly args: Readonly<Record<string, string>>;
    }) => {
      const argv = Either.getOrThrow(serializeToolingInput(task, values));
      return { argv, values: Either.getOrThrow(parseToolingArgv(task, argv)) };
    };
    // When the same input is round-tripped three times
    const first = roundTrip({ flags: { loud: true }, args: { second: "b" } });
    const second = roundTrip(first.values);
    const third = roundTrip(second.values);
    // Then the first parse resolves every declared name and later trips are byte-identical
    expect(first.values.args).toEqual({ first: "a", second: "b" });
    expect(second.argv).toEqual(third.argv);
    expect(second.values).toEqual(third.values);
  });

  test("drops a trailing hole rather than emitting its default", () => {
    // Given a trailing positional with a default
    const task = normalize({ args: { first: { order: 0 }, second: { order: 1, default: "b" } } });
    // When only the leading positional is supplied
    const argv = Either.getOrThrow(serializeToolingInput(task, { flags: {}, args: { first: "a" } }));
    // Then the trailing slot stays absent and the parser applies the default
    expect(argv).toEqual(["--", "a"]);
    expect(Either.getOrThrow(parseToolingArgv(task, argv)).args).toEqual({ first: "a", second: "b" });
  });

  test("treats passthrough argv as trailing input rather than a later declared slot", () => {
    // Given a declaration with two optional positionals
    const task = normalize({ args: { first: { order: 0 }, second: { order: 1 } } });
    // When no declared positional is supplied but raw argv is
    const argv = Either.getOrThrow(
      serializeToolingInput(task, { flags: {}, args: {}, passthroughArgv: ["x"] }),
    );
    // Then nothing is refused and the raw token binds exactly as it would from the CLI
    expect(argv).toEqual(["x"]);
    expect(Either.getOrThrow(parseToolingArgv(task, argv)).args).toEqual({ first: "x" });
  });

  test("reports a missing required argument before an unexpressible hole", () => {
    // Given a required leading argument and a later argument that resolves from its default
    const task = normalize({
      args: { first: { order: 0, required: true }, second: { order: 1 }, third: { order: 2, default: "c" } },
    });
    // When nothing is supplied
    const result = parseToolingArgv(task, []);
    // Then requiredness is reported first
    expect(leftOf(result)).toMatchObject({
      _tag: "ToolingInputError",
      field: "first",
      message: "Missing required argument first.",
    });
  });

  test("keeps the generic remediation on every pre-existing rejection", () => {
    // Given
    const task = normalize({ flags: { name: {} } });
    // When
    const result = parseToolingArgv(task, ["--other"]);
    // Then
    expect(leftOf(result)).toMatchObject({
      remediation: "Check the declared inputs for lando run: Unknown flag other.",
    });
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
