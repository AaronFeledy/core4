import { describe, expect, test } from "bun:test";
import { type ToolingInvocationInput, ToolingTaskShape } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { bindToolingInput, lowerToolingInput, resolveServiceRef } from "../src/tooling-input.ts";
import { type ToolingServiceRef, normalizeToolingTask } from "../src/tooling-normalize.ts";

const normalize = (authored: typeof ToolingTaskShape.Encoded) =>
  Result.getOrThrow(
    normalizeToolingTask("run", Schema.decodeUnknownSync(ToolingTaskShape)(authored), {
      path: "/app/.lando.yml",
    }),
  );
const bind = (authored: typeof ToolingTaskShape.Encoded, invocation: ToolingInvocationInput) => {
  const task = normalize(authored);
  return bindToolingInput(task, task.input, invocation);
};

describe("lossless admission", () => {
  test.each([true, false])("preserves explicit boolean %s over a true default", (loud) => {
    // Given
    const authored = { flags: { loud: { boolean: true, default: true } } };
    // When
    const named = Result.getOrThrow(bind(authored, { _tag: "NamedMaps", flags: { loud }, args: {} }));
    const cli = Result.getOrThrow(bind(authored, { _tag: "RawArgv", argv: [`--loud=${loud}`] }));
    // Then
    expect(named).toEqual({ flags: { loud }, args: {} });
    expect(cli).toEqual(named);
  });

  test.each(Array.from({ length: 32 }, (_, seed) => seed))(
    "equal raw and named logical values for generated case %i",
    (seed) => {
      // Given
      const authored = {
        flags: { mode: { alias: "m" }, loud: { boolean: true, default: true }, absent: {} },
        args: { first: { order: 0 }, second: { order: 1 } },
      };
      const mode = ["", "two words", "a=b", "é\n'\"\\"][seed % 4] ?? "";
      const loud = seed % 2 === 0;
      const first = `first-${seed}`;
      const second = seed % 3 === 0 ? "" : `--second-${seed}`;
      // When
      const raw = Result.getOrThrow(
        bind(authored, { _tag: "RawArgv", argv: [`-m=${mode}`, `--loud=${loud}`, "--", first, second] }),
      );
      const named = Result.getOrThrow(
        bind(authored, { _tag: "NamedMaps", flags: { loud, mode }, args: { second, first } }),
      );
      // Then
      expect(raw).toEqual({ flags: { mode, loud }, args: { first, second } });
      expect(named).toEqual(raw);
      expect(Object.hasOwn(named.flags, "absent")).toBe(false);
    },
  );

  test("keeps sparse named positional identity while argv lowering refuses holes", () => {
    // Given
    const task = normalize({ args: { first: { order: 0 }, second: { order: 1, default: "b" } } });
    // When
    const values = Result.getOrThrow(
      bindToolingInput(task, task.input, { _tag: "NamedMaps", flags: {}, args: {} }),
    );
    const argv = lowerToolingInput(task, task.input, values);
    // Then
    expect(values).toEqual({ flags: {}, args: { second: "b" } });
    expect(argv).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError", field: "first" } });
  });

  test("lowers bound values in declaration order without reparsing or child negation", () => {
    // Given
    const task = normalize({
      flags: { loud: { boolean: true, default: true }, mode: { default: "x" } },
      args: { first: { default: "a" }, second: {} },
    });
    const values = Result.getOrThrow(
      bindToolingInput(task, task.input, {
        _tag: "NamedMaps",
        flags: { loud: false },
        args: { second: "--b" },
      }),
    );
    // When
    const argv = Result.getOrThrow(lowerToolingInput(task, task.input, values));
    // Then
    expect(values).toEqual({ flags: { loud: false, mode: "x" }, args: { first: "a", second: "--b" } });
    expect(argv).toEqual(["--mode=x", "a", "--b"]);
  });

  test.each(["__proto__", "constructor", "toString"])("preserves own identity for %s", (name) => {
    // Given
    const authored = { flags: Object.fromEntries([[name, {}]]), args: Object.fromEntries([[name, {}]]) };
    // When
    const supplied = Result.getOrThrow(
      bind(authored, {
        _tag: "NamedMaps",
        flags: Object.fromEntries([[name, ""]]),
        args: Object.fromEntries([[name, "value"]]),
      }),
    );
    const absent = Result.getOrThrow(bind(authored, { _tag: "NamedMaps", flags: {}, args: {} }));
    // Then
    expect(Object.entries(supplied.flags)).toEqual([[name, ""]]);
    expect(Object.entries(supplied.args)).toEqual([[name, "value"]]);
    expect(Object.hasOwn(absent.flags, name)).toBe(false);
    expect(Object.hasOwn(absent.args, name)).toBe(false);
  });

  const invalid: readonly {
    readonly label: string;
    readonly authored: typeof ToolingTaskShape.Encoded;
    readonly invocation: ToolingInvocationInput;
    readonly field?: string;
  }[] = [
    {
      label: "unknown flag",
      authored: { flags: { mode: {} } },
      invocation: { _tag: "RawArgv", argv: ["--other"] },
    },
    {
      label: "unknown prototype flag",
      authored: { flags: { mode: {} } },
      invocation: { _tag: "RawArgv", argv: ["--toString=x"] },
    },
    {
      label: "boolean numeric spelling",
      authored: { flags: { loud: { boolean: true } } },
      invocation: { _tag: "RawArgv", argv: ["--loud=1"] },
      field: "loud",
    },
    {
      label: "boolean separated value",
      authored: { flags: { loud: { boolean: true } } },
      invocation: { _tag: "RawArgv", argv: ["--loud", "false"] },
    },
    {
      label: "automatic negation",
      authored: { flags: { loud: { boolean: true } } },
      invocation: { _tag: "RawArgv", argv: ["--no-loud"] },
    },
    {
      label: "missing value",
      authored: { flags: { mode: {} } },
      invocation: { _tag: "RawArgv", argv: ["--mode"] },
      field: "mode",
    },
    {
      label: "flag instead of value",
      authored: { flags: { mode: {}, loud: { boolean: true } } },
      invocation: { _tag: "RawArgv", argv: ["--mode", "--loud"] },
      field: "mode",
    },
    {
      label: "required flag",
      authored: { flags: { mode: { required: true } } },
      invocation: { _tag: "NamedMaps", flags: {}, args: {} },
      field: "mode",
    },
    {
      label: "required positional",
      authored: { args: { first: { required: true }, second: { default: "b" } } },
      invocation: { _tag: "RawArgv", argv: [] },
      field: "first",
    },
    {
      label: "flag choice",
      authored: { flags: { mode: { choices: ["x"] } } },
      invocation: { _tag: "NamedMaps", flags: { mode: "canary" }, args: {} },
      field: "mode",
    },
    {
      label: "arg choice",
      authored: { args: { file: { choices: ["x"] } } },
      invocation: { _tag: "RawArgv", argv: ["canary"] },
      field: "file",
    },
    {
      label: "wrong named type",
      authored: { flags: { mode: {} } },
      invocation: { _tag: "NamedMaps", flags: { mode: ["canary"] }, args: {} },
      field: "mode",
    },
    {
      label: "null is not omission",
      authored: { flags: { mode: { default: "x" } } },
      invocation: { _tag: "NamedMaps", flags: { mode: null }, args: {} },
      field: "mode",
    },
    {
      label: "mixed raw declared",
      authored: { args: { first: {}, second: {} } },
      invocation: { _tag: "NamedMaps", flags: {}, args: { second: "b" }, passthroughArgv: ["x"] },
    },
    {
      label: "argument policy",
      authored: { arguments: false, flags: { mode: {} } },
      invocation: { _tag: "RawArgv", argv: ["--mode=x", "canary"] },
    },
    {
      label: "raw argument policy",
      authored: { arguments: false },
      invocation: { _tag: "RawArgv", argv: ["canary"] },
    },
    {
      label: "named argument policy",
      authored: { arguments: false },
      invocation: { _tag: "NamedMaps", flags: {}, args: {}, passthroughArgv: ["canary"] },
    },
  ];
  test.each(invalid)("rejects $label without values", ({ authored, invocation, field }) => {
    // Given / When
    const result = bind(authored, invocation);
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolingInputError", tool: "run", ...(field === undefined ? {} : { field }) },
    });
    expect(JSON.stringify(result)).not.toContain("canary");
  });

  test.each(["flags", "args"] as const)("distinguishes explicit undefined from omission in %s", (group) => {
    // Given
    const task = normalize({ [group]: { mode: { default: "default" } } });
    const supplied = { _tag: "NamedMaps" as const, flags: {}, args: {}, [group]: { mode: undefined } };
    // When
    const result = bindToolingInput(task, task.input, supplied);
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError", field: "mode" } });
  });

  test.each(
    [[], ["--loud"], ["--loud=false", "--loud"], ["--loud", "--loud=false"]].map((argv) => ({ argv })),
  )("preserves last boolean occurrence $argv", ({ argv }) => {
    // Given / When
    const values = Result.getOrThrow(bind({ flags: { loud: { boolean: true } } }, { _tag: "RawArgv", argv }));
    // Then
    expect(values.flags).toEqual(argv.length === 0 ? {} : { loud: argv.at(-1) !== "--loud=false" });
  });
});

describe("service reference admission", () => {
  test.each([
    undefined,
    { kind: "host" },
    { kind: "service", name: "appserver" },
    { kind: "flag", flag: "target" },
  ] satisfies readonly (ToolingServiceRef | undefined)[])("resolves validated %j", (ref) => {
    // Given
    const values = Result.getOrThrow(
      bind({ flags: { target: {} } }, { _tag: "RawArgv", argv: ["--target=web"] }),
    );
    // When
    const result = resolveServiceRef(ref, values);
    // Then
    expect(Result.getOrThrow(result)).toBe(
      ref === undefined
        ? undefined
        : ref.kind === "host"
          ? ":host"
          : ref.kind === "service"
            ? "appserver"
            : "web",
    );
  });
  test.each([undefined, "", true, ":host", ":other", ":"])("refuses invalid service value %j", (value) => {
    // Given / When
    const result = resolveServiceRef(
      { kind: "flag", flag: "target" },
      { flags: value === undefined ? {} : { target: value }, args: {} },
      { name: "deploy" },
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolingInputError", field: "target", tool: "deploy" },
    });
  });
});
