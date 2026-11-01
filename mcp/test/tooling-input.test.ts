import { expect, test } from "bun:test";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { McpToolInputError } from "@lando/sdk/errors";
import { Effect, Result, Schema } from "effect";
import { type McpCommandSpec, deriveToolInputSchema, validateToolInput } from "../src/registry";

const input = Result.getOrThrow(
  normalizeToolingInput("probe", {
    flags: {
      loud: { boolean: true, default: true },
      mode: { choices: ["dev", "prod"], required: true },
      innocent: { sensitive: true },
    },
    args: { target: { required: true }, suffix: { default: "" } },
  }),
);

test("tooling top-level diagnostics never retain unknown names, even without a registered secret", () => {
  const unknownName = 'unknown-"private\\property';
  const supplied = { flags: {}, [unknownName]: "unknown value" };
  try {
    validateToolInput(spec, supplied);
    throw new Error("Expected tooling rejection");
  } catch (error) {
    if (!(error instanceof McpToolInputError)) throw error;
    expect(error.path).toBeUndefined();
    expect(error.message).toBe("Unknown tooling input property.");
    expect(error.remediation).toBe(
      'Tool input accepts only "flags", "args", and "appPath"; remove other properties.',
    );
    expect(JSON.stringify(error)).not.toContain(JSON.stringify(unknownName).slice(1, -1));
  }
});

test("generic-command top-level diagnostics retain their existing property path", () => {
  const generic = {
    id: "app:generic",
    summary: "Generic",
    run: () => Effect.void,
    resultSchema: Schema.Unknown,
  };
  const supplied = { flags: {}, extra: "value" };
  try {
    validateToolInput(generic, supplied);
    throw new Error("Expected generic rejection");
  } catch (error) {
    if (!(error instanceof McpToolInputError)) throw error;
    expect(error.path).toBe("extra");
    expect(error.message).toBe('Unknown input property "extra" for tool app:generic.');
    expect(error.remediation).toBe('Remove "extra"; tool input accepts only "flags", "args", and "appPath".');
  }
});
const spec: McpCommandSpec = {
  id: "app:probe",
  summary: "Probe",
  toolingInput: input,
  run: () => Effect.void,
  resultSchema: Schema.Unknown,
};

test("publishes authoritative enum, defaults, parent requirements, closed groups and sensitivity", () => {
  // Given / When
  const schema = deriveToolInputSchema(spec);
  // Then
  expect(schema).toMatchObject({
    additionalProperties: false,
    required: ["flags", "args"],
    "x-lando-input-revision": input.revision,
    properties: {
      flags: {
        additionalProperties: false,
        required: ["mode"],
        properties: {
          loud: { type: "boolean", default: true },
          mode: { enum: ["dev", "prod"] },
          innocent: { type: "string", writeOnly: true },
        },
      },
      args: {
        additionalProperties: false,
        required: ["target"],
        properties: { suffix: { type: "string", default: "" } },
      },
    },
  });
});

test("leaves tooling omission, invalid types, and false untouched for target admission", () => {
  // Given
  const supplied = { flags: { loud: false, innocent: ["canary"] }, args: { suffix: "" } };
  // When
  const admitted = validateToolInput(spec, supplied);
  // Then
  expect(admitted).toEqual(supplied);
  expect(Object.hasOwn(admitted.flags, "mode")).toBe(false);
  expect(Object.hasOwn(admitted.args, "target")).toBe(false);
});

test.each([null, [], "canary"].map((flags) => ({ flags })))(
  "refuses non-object tooling group $flags without values",
  ({ flags }) => {
    // Given / When / Then
    expect(() => validateToolInput(spec, JSON.parse(JSON.stringify({ flags })))).toThrow("must be an object");
  },
);
