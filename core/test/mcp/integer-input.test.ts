import { expect, test } from "bun:test";
import { buildCatalog, computeEffectiveAllowlist } from "@lando/mcp/catalog";
import { type McpRunInput, dispatchTool } from "@lando/mcp/dispatch";
import { deriveToolInputSchema, validateToolInput } from "@lando/mcp/registry";
import { makeStdioMcpTransport } from "@lando/mcp/stdio-transport";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Either, Option } from "effect";
import { logsSpec } from "../../src/cli/command-specs/app/logs.ts";
import { parseFlagValue } from "../../src/cli/compiled-argv.ts";
import { validateEventCommandInput } from "../../src/cli/event-command-input.ts";
import { validateCliFlagValues } from "../../src/cli/flag-value-validation.ts";
import {
  pluginOwnedCliFlagError,
  pluginOwnedCommandInputFromArgv,
} from "../../src/cli/run-plugin-owned-command.ts";
import { Flags } from "../../src/cli/spec/metadata.ts";

test("projects logs tail as an integer", () => {
  // Given / When
  const schema = deriveToolInputSchema(logsSpec);
  // Then
  expect(schema).toMatchObject({ properties: { flags: { properties: { tail: { type: "integer" } } } } });
});

test("accepts JSON integer tail through the shared validator", () => {
  // Given / When
  const input = validateToolInput(logsSpec, { flags: { tail: 7 } });
  // Then
  expect(input.flags.tail).toBe(7);
});

test("uses integer metadata rather than the flag name on native inputs", () => {
  // Given
  const flags = { count: Flags.integer(), tail: Flags.string() };
  // When / Then
  expect(parseFlagValue(flags.count, "7")).toBe(7);
  expect(parseFlagValue(flags.tail, "seven")).toBe("seven");
  expect(validateCliFlagValues(["--tail=seven"], flags)).toBeUndefined();
  expect(validateCliFlagValues(["--count=7.5"], flags)).toMatchObject({
    _tag: "MalformedCliFlagValueError",
    flag: "count",
    issue: "invalid_integer",
  });
});

test("keeps plugin-owned integer flags on the native validation and parsing path", () => {
  // Given
  const spec = { id: "db:inspect", flags: { count: Flags.integer() } };
  // When
  const error = pluginOwnedCliFlagError(spec, ["--count=7.5"]);
  const parsed = pluginOwnedCommandInputFromArgv(spec, ["--count=7.5"]);
  // Then
  expect(error).toMatchObject({
    _tag: "MalformedCliFlagValueError",
    flag: "count",
    issue: "invalid_integer",
  });
  expect(parsed.flags.count).toBeUndefined();
  expect(pluginOwnedCommandInputFromArgv(spec, ["--count=7"]).flags.count).toBe(7);
});

test("preserves native and structured input error tags for invalid tail", async () => {
  // Given / When
  const cli = validateCliFlagValues(["--tail=1.5"], logsSpec.flags ?? {});
  const event = await Effect.runPromise(
    Effect.either(
      validateEventCommandInput(logsSpec, {
        flags: { tail: 1.5 },
        args: {},
        raw: [],
      }),
    ),
  );
  // Then
  expect(cli).toMatchObject({ _tag: "MalformedCliFlagValueError", flag: "tail" });
  expect(Either.isLeft(event) ? event.left : undefined).toMatchObject({
    _tag: "CommandInputValidationError",
    field: "tail",
  });
});

test.each([1.5, "7", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "rejects invalid tail %s with its own input tag and path",
  (tail) => {
    // Given / When / Then
    expect(() => validateToolInput(logsSpec, { flags: { tail } })).toThrow(
      expect.objectContaining({ _tag: "McpToolInputError", path: "flags.tail" }),
    );
  },
);

test.each([7, 1.5, "7"])("validates real logsSpec tail %s through JSON-RPC transport", async (tail) => {
  // Given
  const commandEntries = [{ spec: logsSpec }];
  const executed: McpRunInput[] = [];
  const writes: string[] = [];
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: logsSpec.id, arguments: { flags: { tail } } },
          })}\n`,
        ),
      );
    },
  });
  // When
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog: buildCatalog({
            commandEntries,
            effective: computeEffectiveAllowlist({ defaults: [logsSpec.id] }),
          }),
          input,
          write: (line) =>
            Effect.sync(() => {
              writes.push(line);
            }),
        });
        const received = yield* transport.receive;
        if (Option.isNone(received)) throw new Error("Missing tools/call request");
        const result = yield* Effect.either(
          dispatchTool(received.value.request, {
            registry: new Map([[logsSpec.id, { spec: logsSpec }]]),
            effective: new Set([logsSpec.id]),
            allowlistSource: "defaults",
            redactor: createRedactor("secrets"),
            execute: (entry, runInput) =>
              Effect.sync(() => {
                expect(entry.spec).toBe(logsSpec);
                executed.push(runInput);
                return { _tag: "success", value: { lines: [] } } as const;
              }),
          }),
        );
        yield* transport.reply(
          Either.isRight(result)
            ? { id: received.value.id, ok: true, result: result.right }
            : { id: received.value.id, ok: false, error: result.left },
        );
        return result;
      }),
    ),
  );
  // Then
  if (tail === 7) {
    expect(Either.isRight(outcome)).toBe(true);
    expect(executed.map((value) => value.flags.tail)).toEqual([tail]);
    expect(writes.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ id: 1, result: expect.anything() }),
    );
  } else {
    expect(executed).toEqual([]);
    expect(Either.isLeft(outcome) ? outcome.left : undefined).toMatchObject({
      _tag: "McpToolInputError",
      path: "flags.tail",
    });
    expect(writes.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ id: 1, error: expect.anything() }),
    );
  }
});
