import { expect, test } from "bun:test";
import { McpToolInputError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";
import type { McpToolingCatalog } from "../src/diagnostics";
import {
  type McpCommandEntry,
  type McpCommandSpec,
  deriveToolInputSchema,
  validateToolInput,
} from "../src/registry";
import type { McpRuntimeConfigShape } from "../src/service";

type Assert<Condition extends true> = Condition;
type CommandEntry = Extract<McpCommandEntry, { readonly kind: "command" }>;
type ToolingEntry = Extract<McpCommandEntry, { readonly kind: "tooling" }>;
type McpCollectionContracts = [
  Assert<ToolingEntry extends McpRuntimeConfigShape["commandEntries"][number] ? false : true>,
  Assert<CommandEntry extends NonNullable<McpRuntimeConfigShape["toolingEntries"]>[number] ? false : true>,
  Assert<CommandEntry extends McpToolingCatalog["entries"][number] ? false : true>,
  Assert<Omit<CommandEntry, "kind"> extends McpCommandEntry ? false : true>,
];

test("ownership types reject missing kinds and cross-placed entries", () => {
  const contracts: McpCollectionContracts = [true, true, true, true];
  expect(contracts).toEqual([true, true, true, true]);
});

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
