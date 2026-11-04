import { expect, test } from "bun:test";
import { McpToolInputError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";
import { type McpCommandSpec, deriveToolInputSchema, validateToolInput } from "../src/registry";

test.each(["stdin", "stdout"] as const)("MCP requires a path instead of CLI %s", (stdio) => {
  const spec: McpCommandSpec = {
    id: "example:dump",
    summary: "Transfer a dump.",
    args: { file: { type: "string", description: "Dump file.", stdio } },
    run: () => Effect.void,
    resultSchema: Schema.Void,
  };
  expect(deriveToolInputSchema(spec)).toMatchObject({
    properties: {
      args: {
        properties: { file: { description: "Dump file. A filesystem path is required; - is CLI-only." } },
      },
    },
  });
  expect(() => validateToolInput(spec, { args: { file: "-" } })).toThrow(McpToolInputError);
  try {
    validateToolInput(spec, { args: { file: "-" } });
  } catch (error) {
    if (!(error instanceof McpToolInputError)) throw error;
    expect(error.path).toBe("args.file");
    expect(error.remediation).toContain("filesystem path");
  }
  expect(validateToolInput(spec, { args: { file: "dump.sql" } }).args.file).toBe("dump.sql");
  expect(
    validateToolInput({ ...spec, args: { file: { type: "string" } } }, { args: { file: "-" } }).args.file,
  ).toBe("-");
});
