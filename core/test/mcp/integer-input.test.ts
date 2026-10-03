import { expect, test } from "bun:test";
import { deriveToolInputSchema, validateToolInput } from "@lando/mcp/registry";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Layer, Result, Schema } from "effect";
import { logsSpec } from "../../src/cli/command-specs/app/logs";
import { parseFlagValue } from "../../src/cli/compiled-argv";
import { validateEventCommandInput } from "../../src/cli/event-command-input";
import { validateCliFlagValues } from "../../src/cli/flag-value-validation";
import {
  pluginOwnedCliFlagError,
  pluginOwnedCommandInputFromArgv,
} from "../../src/cli/run-plugin-owned-command";
import { Flags } from "../../src/cli/spec/metadata";
import { serviceLayer } from "../../src/mcp-command-executor";

test("projects logs tail as an integer", () => {
  expect(deriveToolInputSchema(logsSpec)).toMatchObject({
    properties: { flags: { properties: { tail: { type: "integer" } } } },
  });
});
test("accepts JSON integer tail through the shared validator", () => {
  expect(validateToolInput(logsSpec, { flags: { tail: 7 } }).flags.tail).toBe(7);
});
test("uses integer metadata rather than the flag name on native inputs", () => {
  const flags = { count: Flags.integer(), tail: Flags.string() };
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
  const spec = { id: "db:inspect", flags: { count: Flags.integer() } };
  expect(pluginOwnedCliFlagError(spec, ["--count=7.5"])).toMatchObject({
    _tag: "MalformedCliFlagValueError",
    flag: "count",
    issue: "invalid_integer",
  });
  expect(pluginOwnedCommandInputFromArgv(spec, ["--count=7.5"]).flags.count).toBeUndefined();
  expect(pluginOwnedCommandInputFromArgv(spec, ["--count=7"]).flags.count).toBe(7);
});
test("preserves native and structured input error tags for invalid tail", async () => {
  const event = await Effect.runPromise(
    Effect.result(validateEventCommandInput(logsSpec, { flags: { tail: 1.5 }, args: {}, raw: [] })),
  );
  expect(validateCliFlagValues(["--tail=1.5"], logsSpec.flags ?? {})).toMatchObject({
    _tag: "MalformedCliFlagValueError",
    flag: "tail",
  });
  expect(Result.isFailure(event) ? event.failure : undefined).toMatchObject({
    _tag: "CommandInputValidationError",
    field: "tail",
  });
});
test.each([1.5, "7", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "rejects invalid tail %s with its own input tag and path",
  (tail) => {
    expect(() => validateToolInput(logsSpec, { flags: { tail } })).toThrow(
      expect.objectContaining({ _tag: "McpToolInputError", path: "flags.tail" }),
    );
  },
);
test.each([7, 1.5, "7"])("validates real logsSpec tail %s through JSON-RPC transport", async (tail) => {
  const executed: unknown[] = [];
  const spec = {
    ...logsSpec,
    run: (input: { readonly flags: Record<string, unknown> }) =>
      Effect.sync(() => {
        executed.push(input.flags.tail);
        return { lines: [] };
      }),
  };
  const layer = serviceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          McpRuntimeConfig,
          McpRuntimeConfig.of({
            commandEntries: [{ spec }],
            defaultAllowlist: [logsSpec.id],
            runtimeLayer: Layer.empty,
          }),
        ),
        Layer.succeed(
          RedactionService,
          RedactionService.of({
            registerValues: registerRedactionValues,
            forProfile: () => Effect.succeed(createRedactor("secrets")),
          }),
        ),
      ),
    ),
  );
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio" }));
        return yield* client.request("tools/call", { name: logsSpec.id, arguments: { flags: { tail } } });
      }),
    ).pipe(Effect.provide(layer)),
  );
  if (tail === 7) {
    expect(executed).toEqual([tail]);
    expect(response).toMatchObject({ result: { isError: false, structuredContent: { ok: true } } });
  } else {
    expect(executed).toEqual([]);
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        isError: Schema.Literal(true),
        content: Schema.Array(Schema.Struct({ text: Schema.String })),
      }),
    )(response.result);
    expect(JSON.parse(result.content[0]?.text ?? "null")).toMatchObject({
      _tag: "McpToolInputError",
      path: "flags.tail",
      toolId: logsSpec.id,
    });
    expect(Schema.decodeUnknownSync(Schema.JsonObject)(response.result).structuredContent).toBeUndefined();
  }
});
